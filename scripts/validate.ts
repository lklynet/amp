import Database from "better-sqlite3"

type ValidationResult = {
  mbid: string
  type: "artist" | "release_group" | "release"
  ok: boolean
  reason?: string
}

const releaseUrl = (mbid: string) => `https://coverartarchive.org/release/${mbid}/front-500`
const releaseGroupUrl = (mbid: string) =>
  `https://coverartarchive.org/release-group/${mbid}/front-500`

const parseList = (value: string | undefined) =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    : []

const openDb = (dbPath: string) => new Database(dbPath, { readonly: true })

type SqliteDatabase = ReturnType<typeof openDb>

const validateArtist = (db: SqliteDatabase, mbid: string): ValidationResult => {
  const row = db.prepare("SELECT mbid, name FROM artist WHERE mbid = ?").get(mbid) as
    | { mbid: string; name: string }
    | undefined
  if (!row) {
    return { mbid, type: "artist", ok: false, reason: "missing" }
  }
  return { mbid, type: "artist", ok: true }
}

const validateReleaseGroup = (db: SqliteDatabase, mbid: string): ValidationResult => {
  const row = db
    .prepare(
      "SELECT mbid, caa_url, canonical_release_mbid, canonical_release_caa_url FROM release_group WHERE mbid = ?"
    )
    .get(mbid) as
    | {
        mbid: string
        caa_url: string
        canonical_release_mbid: string | null
        canonical_release_caa_url: string | null
      }
    | undefined
  if (!row) {
    return { mbid, type: "release_group", ok: false, reason: "missing" }
  }
  if (row.caa_url !== releaseGroupUrl(row.mbid)) {
    return { mbid, type: "release_group", ok: false, reason: "release_group_caa_url" }
  }
  if (row.canonical_release_mbid) {
    const expected = releaseUrl(row.canonical_release_mbid)
    if (row.canonical_release_caa_url !== expected) {
      return { mbid, type: "release_group", ok: false, reason: "canonical_release_caa_url" }
    }
  }
  return { mbid, type: "release_group", ok: true }
}

const validateRelease = (db: SqliteDatabase, mbid: string): ValidationResult => {
  const row = db.prepare("SELECT mbid, caa_url FROM release WHERE mbid = ?").get(mbid) as
    | { mbid: string; caa_url: string }
    | undefined
  if (!row) {
    return { mbid, type: "release", ok: false, reason: "missing" }
  }
  if (row.caa_url !== releaseUrl(row.mbid)) {
    return { mbid, type: "release", ok: false, reason: "release_caa_url" }
  }
  return { mbid, type: "release", ok: true }
}

const run = () => {
  const dbPath = process.env.OUT_DB ?? "out/aurral.db"
  const db = openDb(dbPath)
  const results: ValidationResult[] = []
  for (const mbid of parseList(process.env.SAMPLE_ARTIST_MBID)) {
    results.push(validateArtist(db, mbid))
  }
  for (const mbid of parseList(process.env.SAMPLE_RELEASE_GROUP_MBID)) {
    results.push(validateReleaseGroup(db, mbid))
  }
  for (const mbid of parseList(process.env.SAMPLE_RELEASE_MBID)) {
    results.push(validateRelease(db, mbid))
  }
  db.close()
  console.log(JSON.stringify({ results }, null, 2))
  const failures = results.filter((result) => !result.ok)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

run()
