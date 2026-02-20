# Aurral Metadata Provider

This project provides a Cloudflare Worker API backed by D1, plus a Dockerized updater that builds the D1 dataset from the MusicBrainz dump.

## How It Fits Together

- **Worker + D1 (Cloudflare)**: Always-on API for MBID lookups.
- **Updater (Docker)**: Downloads and restores the MusicBrainz dump, builds the slim DB, and imports into D1 on a schedule.

## Cloudflare Deployment

1. Create a D1 database:

```
npx wrangler d1 create aurral_metadata
```

2. Apply the schema:

```
npx wrangler d1 migrations apply aurral_metadata --remote --file migrations/0001_init.sql
```

3. Configure the Worker build:
- Add env var `D1_DATABASE_ID` in the Cloudflare build settings.
- Build command: `npm run prepare:wrangler`
- Deploy command: `npx wrangler deploy src/worker.ts`

4. Add the D1 binding in the Cloudflare UI:
- Binding name: `DB`
- Database: `aurral_metadata`

## Docker Updater

The updater runs once on startup and then weekly if `SCHEDULE_CRON` is set.

Required environment variables:
- `D1_DATABASE`
- `D1_DATABASE_ID`
- `MB_DUMP_URL` (use `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/`)
- `EMBEDDED_PG=true`

Optional:
- `SCHEDULE_CRON` (cron schedule, default in compose is Monday 03:00)
- `WORK_DIR` (defaults to `/data`)

### docker-compose

Edit the image in `docker-compose.yml` to match your GHCR repo, then run:

```
docker compose run --rm aurral-updater
```

To keep it running weekly:

```
docker compose up -d
```

## API Routes

- `GET /artist/{mbid}`
- `GET /release-group/{mbid}`
- `GET /release/{mbid}`
- `GET /batch?artist_mbid=...&release_group_mbid=...&release_mbid=...`
