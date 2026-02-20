import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { Client } from "pg"

type IngestOptions = {
  outputPath: string
  batchSize: number
  pgUrl: string
}

const releaseUrl = (mbid: string) => `https://coverartarchive.org/release/${mbid}/front-500`
const releaseGroupUrl = (mbid: string) =>
  `https://coverartarchive.org/release-group/${mbid}/front-500`

const readSchema = () => {
  const schemaPath = new URL("../migrations/0001_init.sql", import.meta.url)
  return fs.readFileSync(schemaPath, "utf8")
}

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
}

const createSqlite = (outputPath: string) => {
  ensureDir(outputPath)
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath)
  }
  const db = new Database(outputPath)
  db.exec(readSchema())
  return db
}

type SqliteDatabase = ReturnType<typeof createSqlite>

const createCanonicalReleaseTable = async (client: Client) => {
  await client.query(`
    CREATE TEMP TABLE canonical_release AS
    SELECT release_group_mbid, release_mbid FROM (
      SELECT
        rg.gid as release_group_mbid,
        r.gid as release_mbid,
        rs.name as status_name,
        r.date_year,
        r.date_month,
        r.date_day,
        r.id,
        ROW_NUMBER() OVER (
          PARTITION BY rg.id
          ORDER BY
            (rs.name = 'Official') DESC,
            r.date_year NULLS LAST,
            r.date_month NULLS LAST,
            r.date_day NULLS LAST,
            r.id
        ) as rn
      FROM release_group rg
      JOIN release r ON r.release_group = rg.id
      LEFT JOIN release_status rs ON rs.id = r.status
    ) ranked
    WHERE rn = 1
  `)
  await client.query(
    "CREATE INDEX canonical_release_release_group_mbid ON canonical_release(release_group_mbid)"
  )
}

const ingestArtists = async (client: Client, db: SqliteDatabase, batchSize: number) => {
  let lastId = 0
  const insert = db.prepare("INSERT INTO artist (mbid, name) VALUES (?, ?)")
  while (true) {
    const result = await client.query(
      "SELECT id, gid, name FROM artist WHERE id > $1 ORDER BY id LIMIT $2",
      [lastId, batchSize]
    )
    if (result.rows.length === 0) {
      break
    }
    const tx = db.transaction((rows: typeof result.rows) => {
      for (const row of rows) {
        insert.run(row.gid, row.name)
      }
    })
    tx(result.rows)
    lastId = result.rows[result.rows.length - 1].id
  }
}

const ingestArtistCredits = async (client: Client, db: SqliteDatabase, batchSize: number) => {
  let lastId = 0
  const insert = db.prepare("INSERT INTO artist_credit (credit_id) VALUES (?)")
  while (true) {
    const result = await client.query(
      "SELECT id FROM artist_credit WHERE id > $1 ORDER BY id LIMIT $2",
      [lastId, batchSize]
    )
    if (result.rows.length === 0) {
      break
    }
    const tx = db.transaction((rows: typeof result.rows) => {
      for (const row of rows) {
        insert.run(row.id)
      }
    })
    tx(result.rows)
    lastId = result.rows[result.rows.length - 1].id
  }
}

const ingestArtistCreditNames = async (client: Client, db: SqliteDatabase, batchSize: number) => {
  let lastCreditId = 0
  let lastPosition = -1
  const insert = db.prepare(
    "INSERT INTO artist_credit_name (credit_id, artist_mbid, name, join_phrase, position) VALUES (?, ?, ?, ?, ?)"
  )
  while (true) {
    const result = await client.query(
      `
      SELECT
        acn.artist_credit as credit_id,
        a.gid as artist_mbid,
        acn.name,
        acn.join_phrase,
        acn.position
      FROM artist_credit_name acn
      JOIN artist a ON a.id = acn.artist
      WHERE (acn.artist_credit, acn.position) > ($1, $2)
      ORDER BY acn.artist_credit, acn.position
      LIMIT $3
      `,
      [lastCreditId, lastPosition, batchSize]
    )
    if (result.rows.length === 0) {
      break
    }
    const tx = db.transaction((rows: typeof result.rows) => {
      for (const row of rows) {
        insert.run(row.credit_id, row.artist_mbid, row.name, row.join_phrase, row.position)
      }
    })
    tx(result.rows)
    const lastRow = result.rows[result.rows.length - 1]
    lastCreditId = lastRow.credit_id
    lastPosition = lastRow.position
  }
}

const ingestReleaseGroups = async (client: Client, db: SqliteDatabase, batchSize: number) => {
  let lastId = 0
  const insert = db.prepare(
    "INSERT INTO release_group (mbid, title, artist_credit_id, canonical_release_mbid, caa_url, canonical_release_caa_url) VALUES (?, ?, ?, ?, ?, ?)"
  )
  while (true) {
    const result = await client.query(
      `
      SELECT
        rg.id,
        rg.gid as mbid,
        rg.name as title,
        rg.artist_credit as artist_credit_id,
        cr.release_mbid as canonical_release_mbid
      FROM release_group rg
      LEFT JOIN canonical_release cr ON cr.release_group_mbid = rg.gid
      WHERE rg.id > $1
      ORDER BY rg.id
      LIMIT $2
      `,
      [lastId, batchSize]
    )
    if (result.rows.length === 0) {
      break
    }
    const tx = db.transaction((rows: typeof result.rows) => {
      for (const row of rows) {
        const caa = releaseGroupUrl(row.mbid)
        const canonicalCaa = row.canonical_release_mbid
          ? releaseUrl(row.canonical_release_mbid)
          : null
        insert.run(
          row.mbid,
          row.title,
          row.artist_credit_id,
          row.canonical_release_mbid,
          caa,
          canonicalCaa
        )
      }
    })
    tx(result.rows)
    lastId = result.rows[result.rows.length - 1].id
  }
}

const ingestReleases = async (client: Client, db: SqliteDatabase, batchSize: number) => {
  let lastId = 0
  const insertRelease = db.prepare(
    "INSERT INTO release (mbid, title, release_group_mbid, artist_credit_id, caa_url) VALUES (?, ?, ?, ?, ?)"
  )
  const insertJoin = db.prepare(
    "INSERT INTO release_group_release (release_group_mbid, release_mbid) VALUES (?, ?)"
  )
  while (true) {
    const result = await client.query(
      `
      SELECT
        r.id,
        r.gid as mbid,
        r.name as title,
        rg.gid as release_group_mbid,
        r.artist_credit as artist_credit_id
      FROM release r
      JOIN release_group rg ON rg.id = r.release_group
      WHERE r.id > $1
      ORDER BY r.id
      LIMIT $2
      `,
      [lastId, batchSize]
    )
    if (result.rows.length === 0) {
      break
    }
    const tx = db.transaction((rows: typeof result.rows) => {
      for (const row of rows) {
        insertRelease.run(
          row.mbid,
          row.title,
          row.release_group_mbid,
          row.artist_credit_id,
          releaseUrl(row.mbid)
        )
        insertJoin.run(row.release_group_mbid, row.mbid)
      }
    })
    tx(result.rows)
    lastId = result.rows[result.rows.length - 1].id
  }
}

export const buildDatabase = async ({ outputPath, batchSize, pgUrl }: IngestOptions) => {
  const db = createSqlite(outputPath)
  const client = new Client({ connectionString: pgUrl })
  await client.connect()

  await createCanonicalReleaseTable(client)
  await ingestArtists(client, db, batchSize)
  await ingestArtistCredits(client, db, batchSize)
  await ingestArtistCreditNames(client, db, batchSize)
  await ingestReleaseGroups(client, db, batchSize)
  await ingestReleases(client, db, batchSize)

  await client.end()
  db.close()
}

const run = async () => {
  const pgUrl = process.env.MB_PG_URL
  if (!pgUrl) {
    throw new Error("MB_PG_URL is required")
  }
  const outputPath = process.env.OUT_DB ?? "out/aurral.db"
  const batchSize = Number(process.env.BATCH_SIZE ?? "5000")
  await buildDatabase({ outputPath, batchSize, pgUrl })
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
