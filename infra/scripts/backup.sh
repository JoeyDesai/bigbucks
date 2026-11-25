#!/usr/bin/env bash
# Take an on-demand database backup now (same format as the nightly job).
# Runs on the server:  ~/homebase/infra/scripts/backup.sh
# From the dev machine: ssh homebase-server '~/homebase/infra/scripts/backup.sh'
#
# The nightly 03:30 America/New_York dump is done by the `backup` container
# itself; this script just asks that container for one extra run.
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/infra/scripts/compose.sh"

case "${1:-}" in
  -h|--help)
    sed -n '2,8p' "$0"; exit 0 ;;
  --list)
    found=0
    for f in "$ROOT"/backups/homebase-*.dump; do
      [ -e "$f" ] || continue
      ls -lh "$f"; found=1
    done
    [ "$found" = 1 ] || echo "no dumps yet in $ROOT/backups"
    [ -f "$ROOT/backups/.last-success" ] && echo "last success: $(cat "$ROOT/backups/.last-success")"
    [ -f "$ROOT/backups/.last-failure" ] && echo "LAST FAILURE: $(cat "$ROOT/backups/.last-failure")"
    exit 0 ;;
esac

# Make sure postgres and the backup sidecar are up (does not touch web/worker).
"$COMPOSE" up -d --wait postgres >/dev/null
"$COMPOSE" up -d backup >/dev/null

# Progress logs arrive on stderr; stdout is just the dump path inside the container.
container_path=$("$COMPOSE" exec -T backup bash /backup/pgdump.sh once | tail -n1)
case "$container_path" in
  /backups/*) ;;
  *) echo "backup.sh: backup did not report a dump path" >&2; exit 1 ;;
esac
host_path="$ROOT/backups/${container_path#/backups/}"
echo "Backup written: $host_path"
