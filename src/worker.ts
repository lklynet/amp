type D1Database = {
  prepare: (query: string) => {
    bind: (...args: (string | number | null)[]) => {
      first: <T>() => Promise<T | null>
      all: <T>() => Promise<{ results: T[] }>
    }
  }
}

type Artist = {
  mbid: string
  name: string
  images: {
    release_group: string | null
    release: string | null
  }
}

type ArtistCreditEntry = {
  credit_id: number
  artist_mbid: string
  name: string
  join_phrase: string
  position: number
}

type ReleaseGroup = {
  mbid: string
  title: string
  artist_credit: ArtistCreditEntry[]
  images: {
    release_group: string
    release: string | null
  }
}

type Release = {
  mbid: string
  title: string
  release_group_mbid: string
  artist_credit: ArtistCreditEntry[]
  images: {
    release: string
  }
}

type BatchResponse = {
  artists: Artist[]
  release_groups: ReleaseGroup[]
  releases: Release[]
}

type Env = {
  DB: D1Database
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  })

const notFound = () => jsonResponse({ error: "Not Found" }, 404)

const methodNotAllowed = () => jsonResponse({ error: "Method Not Allowed" }, 405)

const normalizeMbid = (mbid: string) => mbid.toLowerCase()

const parseList = (value: string | null) =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    : []

const fetchArtistCredit = async (db: D1Database, creditId: number) => {
  const results = await db
    .prepare(
      "SELECT credit_id, artist_mbid, name, join_phrase, position FROM artist_credit_name WHERE credit_id = ? ORDER BY position"
    )
    .bind(creditId)
    .all<ArtistCreditEntry>()
  return results.results ?? []
}

const fetchArtist = async (db: D1Database, mbid: string): Promise<Artist | null> => {
  const artist = await db
    .prepare("SELECT mbid, name FROM artist WHERE mbid = ?")
    .bind(mbid)
    .first<{ mbid: string; name: string }>()

  if (!artist) {
    return null
  }

  const imageRow = await db
    .prepare(
      "SELECT rg.caa_url as release_group_url, rg.canonical_release_caa_url as release_url FROM release_group rg JOIN artist_credit_name acn ON acn.credit_id = rg.artist_credit_id WHERE acn.artist_mbid = ? ORDER BY rg.mbid LIMIT 1"
    )
    .bind(mbid)
    .first<{ release_group_url: string | null; release_url: string | null }>()

  return {
    mbid: artist.mbid,
    name: artist.name,
    images: {
      release_group: imageRow?.release_group_url ?? null,
      release: imageRow?.release_url ?? null
    }
  }
}

const fetchReleaseGroup = async (
  db: D1Database,
  mbid: string
): Promise<ReleaseGroup | null> => {
  const releaseGroup = await db
    .prepare(
      "SELECT mbid, title, artist_credit_id, caa_url, canonical_release_caa_url FROM release_group WHERE mbid = ?"
    )
    .bind(mbid)
    .first<{
      mbid: string
      title: string
      artist_credit_id: number
      caa_url: string
      canonical_release_caa_url: string | null
    }>()

  if (!releaseGroup) {
    return null
  }

  const artistCredit = await fetchArtistCredit(db, releaseGroup.artist_credit_id)

  return {
    mbid: releaseGroup.mbid,
    title: releaseGroup.title,
    artist_credit: artistCredit,
    images: {
      release_group: releaseGroup.caa_url,
      release: releaseGroup.canonical_release_caa_url ?? null
    }
  }
}

const fetchRelease = async (db: D1Database, mbid: string): Promise<Release | null> => {
  const release = await db
    .prepare(
      "SELECT mbid, title, release_group_mbid, artist_credit_id, caa_url FROM release WHERE mbid = ?"
    )
    .bind(mbid)
    .first<{
      mbid: string
      title: string
      release_group_mbid: string
      artist_credit_id: number
      caa_url: string
    }>()

  if (!release) {
    return null
  }

  const artistCredit = await fetchArtistCredit(db, release.artist_credit_id)

  return {
    mbid: release.mbid,
    title: release.title,
    release_group_mbid: release.release_group_mbid,
    artist_credit: artistCredit,
    images: {
      release: release.caa_url
    }
  }
}

const fetchBatch = async (db: D1Database, url: URL): Promise<BatchResponse> => {
  const artistMbids = parseList(url.searchParams.get("artist_mbid"))
  const releaseGroupMbids = parseList(url.searchParams.get("release_group_mbid"))
  const releaseMbids = parseList(url.searchParams.get("release_mbid"))

  const artists = await Promise.all(
    artistMbids.map(async (mbid) => (await fetchArtist(db, mbid)) ?? null)
  )
  const releaseGroups = await Promise.all(
    releaseGroupMbids.map(async (mbid) => (await fetchReleaseGroup(db, mbid)) ?? null)
  )
  const releases = await Promise.all(
    releaseMbids.map(async (mbid) => (await fetchRelease(db, mbid)) ?? null)
  )

  return {
    artists: artists.filter((entry): entry is Artist => entry !== null),
    release_groups: releaseGroups.filter((entry): entry is ReleaseGroup => entry !== null),
    releases: releases.filter((entry): entry is Release => entry !== null)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return methodNotAllowed()
    }

    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter((part) => part.length > 0)

    if (parts.length === 2 && parts[0] === "artist") {
      const artist = await fetchArtist(env.DB, normalizeMbid(parts[1]))
      return artist ? jsonResponse(artist) : notFound()
    }

    if (parts.length === 2 && parts[0] === "release-group") {
      const releaseGroup = await fetchReleaseGroup(env.DB, normalizeMbid(parts[1]))
      return releaseGroup ? jsonResponse(releaseGroup) : notFound()
    }

    if (parts.length === 2 && parts[0] === "release") {
      const release = await fetchRelease(env.DB, normalizeMbid(parts[1]))
      return release ? jsonResponse(release) : notFound()
    }

    if (parts.length === 1 && parts[0] === "batch") {
      const batch = await fetchBatch(env.DB, url)
      return jsonResponse(batch)
    }

    return notFound()
  }
}
