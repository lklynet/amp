#!/usr/bin/env bash
set -euo pipefail

MB_PG_URL="${MB_PG_URL:-}"
MB_PG_ADMIN_URL="${MB_PG_ADMIN_URL:-}"
MB_PG_DB_NAME="${MB_PG_DB_NAME:-}"
MB_DUMP_URL="${MB_DUMP_URL:-}"
MB_DUMP_SQL="${MB_DUMP_SQL:-}"
WORK_DIR="${WORK_DIR:-/data}"
EMBEDDED_PG="${EMBEDDED_PG:-false}"
PGDATA="${PGDATA:-/data/pg}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGDB="${PGDB:-musicbrainz}"
SCHEDULE_CRON="${SCHEDULE_CRON:-}"
PG_BIN_DIR="${PG_BIN_DIR:-}"
PG_STARTED="false"

run_once() {
if [[ "$EMBEDDED_PG" == "true" ]]; then
  if [[ -z "$PG_BIN_DIR" ]]; then
    PG_BIN_DIR="$(dirname "$(command -v initdb 2>/dev/null || true)")"
  fi
  if [[ -z "$PG_BIN_DIR" || "$PG_BIN_DIR" == "." ]]; then
    PG_BIN_DIR="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "$PG_BIN_DIR" ]]; then
    echo "PostgreSQL binaries not found. Set PG_BIN_DIR or install postgresql server."
    exit 1
  fi
  mkdir -p "$PGDATA" "$WORK_DIR"
  chown -R postgres:postgres "$PGDATA" "$WORK_DIR"
  if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
    su - postgres -c "$PG_BIN_DIR/initdb -D $PGDATA"
  fi
  su - postgres -c "$PG_BIN_DIR/pg_ctl -D $PGDATA -o '-F -p $PGPORT -h 127.0.0.1' -w start"
  PG_STARTED="true"
  MB_PG_ADMIN_URL="postgresql://$PGUSER@127.0.0.1:$PGPORT/postgres"
  MB_PG_DB_NAME="$PGDB"
  MB_PG_URL="postgresql://$PGUSER@127.0.0.1:$PGPORT/$PGDB"
fi

if [[ -z "$MB_PG_URL" ]]; then
  echo "MB_PG_URL is required unless EMBEDDED_PG=true"
  exit 1
fi

if [[ -n "$MB_DUMP_URL" || -n "$MB_DUMP_SQL" ]]; then
  if [[ -z "$MB_PG_ADMIN_URL" || -z "$MB_PG_DB_NAME" ]]; then
    echo "MB_PG_ADMIN_URL and MB_PG_DB_NAME are required for restore"
    exit 1
  fi
fi

if [[ -n "$MB_DUMP_URL" ]]; then
  MB_DUMP_URL="$(echo "$MB_DUMP_URL" | tr -d '\r\n')"
  if [[ "$MB_DUMP_URL" == *"/fullexport" || "$MB_DUMP_URL" == *"/fullexport/" ]]; then
    BASE_URL="${MB_DUMP_URL%/}"
    LATEST_DIR="$(curl -fsSL "$BASE_URL/LATEST" | tr -d '\r\n' || true)"
    if [[ "$LATEST_DIR" == latest-is-* ]]; then
      LATEST_DIR="${LATEST_DIR#latest-is-}"
    fi
    if [[ -z "$LATEST_DIR" ]]; then
      LATEST_DIR="$(curl -fsSL "$BASE_URL/" | grep -o 'latest-is-[0-9]\{8\}-[0-9]\{6\}' | head -n 1 || true)"
      if [[ "$LATEST_DIR" == latest-is-* ]]; then
        LATEST_DIR="${LATEST_DIR#latest-is-}"
      fi
    fi
    if [[ -z "$LATEST_DIR" ]]; then
      echo "Unable to resolve latest fullexport directory from $BASE_URL/LATEST"
      exit 1
    fi
    MB_DUMP_URL="$BASE_URL/$LATEST_DIR/mbdump.tar.bz2"
  fi
  echo "Resolved MB_DUMP_URL=$MB_DUMP_URL"
  mkdir -p "$WORK_DIR"
  DUMP_FILE="${MB_DUMP_FILE:-$WORK_DIR/mbdump.tar.bz2}"
  if [[ "${FORCE_DOWNLOAD:-false}" == "true" || ! -f "$DUMP_FILE" ]]; then
    rm -f "$DUMP_FILE"
    echo "Downloading $MB_DUMP_URL"
    curl -fL --retry 3 --retry-delay 5 "$MB_DUMP_URL" -o "$DUMP_FILE"
  fi
  if ! bzip2 -t "$DUMP_FILE" >/dev/null 2>&1; then
    echo "Downloaded file is not a valid bzip2 archive. Redownloading."
    rm -f "$DUMP_FILE"
    curl -fL --retry 3 --retry-delay 5 "$MB_DUMP_URL" -o "$DUMP_FILE"
    if ! bzip2 -t "$DUMP_FILE" >/dev/null 2>&1; then
      echo "Downloaded file is not a valid bzip2 archive. Check MB_DUMP_URL."
      exit 1
    fi
  fi
  EXTRACT_DIR="$WORK_DIR/mbdump"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  tar -xjf "$DUMP_FILE" -C "$EXTRACT_DIR"
fi

if [[ -z "$MB_DUMP_SQL" && -d "$WORK_DIR" ]]; then
  MB_DUMP_SQL="$(find "$WORK_DIR" -type f -name "*.sql" | head -n 1 || true)"
fi

if [[ -n "$MB_DUMP_SQL" ]]; then
  psql "$MB_PG_ADMIN_URL" -c "DROP DATABASE IF EXISTS $MB_PG_DB_NAME;"
  psql "$MB_PG_ADMIN_URL" -c "CREATE DATABASE $MB_PG_DB_NAME;"
  psql "$MB_PG_ADMIN_URL" -d "$MB_PG_DB_NAME" -f "$MB_DUMP_SQL"
fi

if [[ -z "${D1_DATABASE:-}" ]]; then
  echo "D1_DATABASE is required"
  exit 1
fi

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "D1_DATABASE_ID is required"
  exit 1
fi

npm run prepare:wrangler
npm run build:weekly

if [[ "$EMBEDDED_PG" == "true" ]]; then
  su - postgres -c "$PG_BIN_DIR/pg_ctl -D $PGDATA -w stop"
fi
}

cleanup() {
  if [[ "$EMBEDDED_PG" == "true" && "$PG_STARTED" == "true" ]]; then
    su - postgres -c "$PG_BIN_DIR/pg_ctl -D $PGDATA -m fast -w stop" || true
  fi
}

trap cleanup EXIT

if [[ -n "$SCHEDULE_CRON" ]]; then
  echo "$SCHEDULE_CRON /app/scripts/updater.sh" > /etc/cron.d/aurral-updater
  chmod 0644 /etc/cron.d/aurral-updater
  crontab /etc/cron.d/aurral-updater
  run_once
  cron -f
else
  run_once
fi
