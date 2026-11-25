#!/usr/bin/env bash
# Local dev Postgres using Homebrew postgres@16 binaries; data lives in .dev/pgdata (gitignored).
set -euo pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
cd "$(dirname "$0")/../.."
PGDATA=.dev/pgdata; PORT=${PGPORT:-54329}
if [ ! -d "$PGDATA" ]; then
  mkdir -p .dev
  initdb -D "$PGDATA" -U homebase --auth=trust -E UTF8 >/dev/null
fi
if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -o "-p $PORT -k /tmp" -l .dev/postgres.log start >/dev/null
  sleep 1
fi
createdb -h localhost -p "$PORT" -U homebase homebase 2>/dev/null || true
createdb -h localhost -p "$PORT" -U homebase homebase_test 2>/dev/null || true
echo "DATABASE_URL=postgres://homebase@localhost:$PORT/homebase"
