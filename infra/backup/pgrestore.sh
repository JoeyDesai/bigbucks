#!/usr/bin/env bash
# Runs INSIDE the `backup` container (postgres:18 image). Driven by
# infra/scripts/restore.sh on the host; not meant to be run by hand.
#
#   pgrestore.sh drill   /backups/homebase-....dump [--keep]
#       Restore into a scratch database (homebase_restore_drill), compare row
#       counts with the .counts manifest written at dump time, then drop it.
#   pgrestore.sh replace /backups/homebase-....dump
#       DROP the live database and restore the dump in its place. The host
#       script stops web/worker and takes a safety dump first.
#
# Exit status: 0 = restored and every table's row count matches the manifest.
set -euo pipefail

LIVE_DB=${PGDATABASE:-homebase}
DRILL_DB=homebase_restore_drill
OWNER=${PGUSER:-homebase}

log() { printf 'restore: %s\n' "$*"; }
die() { printf 'restore: ERROR: %s\n' "$*" >&2; exit 1; }

mode=${1:-}
dump=${2:-}
keep=${3:-}
[[ $mode == drill || $mode == replace ]] || die "usage: $0 drill|replace <dump> [--keep]"
[[ -f $dump ]] || die "dump not found: $dump"

stem=${dump%.dump}
manifest="$stem.counts"
roles="$stem.roles.sql"

pg_restore --list "$dump" >/dev/null || die "not a readable pg_dump archive: $dump"

# Count rows in every user table of database $1, same format as pgdump.sh.
count_rows() {
  psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
ORDER BY n.nspname, c.relname
\gexec
SQL
}

# Re-create roles referenced by GRANTs (fresh server case). "already exists"
# errors are expected on a server that has them, so errors are not fatal here.
apply_roles() {
  if [[ -f $roles ]]; then
    log "applying roles from $(basename "$roles") (existing roles are left as they are)"
    psql -X -q -d postgres -f "$roles" >/dev/null 2>&1 || true
  else
    log "no roles file next to the dump; assuming roles already exist"
  fi
}

restore_into() {
  local db=$1
  log "restoring $(basename "$dump") into database '$db'"
  PGOPTIONS="-c client_min_messages=warning" dropdb --if-exists --force --maintenance-db=postgres "$db"
  createdb --maintenance-db=postgres -O "$OWNER" "$db"
  pg_restore --exit-on-error --no-password -d "$db" "$dump"
}

verify_counts() {
  local db=$1 actual
  actual=$(mktemp)
  count_rows "$db" >"$actual"
  local tables
  tables=$(wc -l <"$actual" | tr -d ' ')
  if [[ ! -f $manifest ]]; then
    log "WARNING: no manifest ($(basename "$manifest")); cannot compare. Restored $tables tables:"
    column -t -s '|' "$actual" 2>/dev/null || cat "$actual"
    rm -f "$actual"
    return 1
  fi
  local bad=0 name want got
  printf '%-48s %12s %12s  %s\n' TABLE EXPECTED RESTORED STATUS
  while IFS='|' read -r name want; do
    [[ -n $name ]] || continue
    got=$(awk -F'|' -v t="$name" '$1==t {print $2}' "$actual")
    if [[ -z $got ]]; then
      printf '%-48s %12s %12s  %s\n' "$name" "$want" "-" MISSING; bad=1
    elif [[ $got != "$want" ]]; then
      printf '%-48s %12s %12s  %s\n' "$name" "$want" "$got" MISMATCH; bad=1
    else
      printf '%-48s %12s %12s  %s\n' "$name" "$want" "$got" ok
    fi
  done <"$manifest"
  # Tables present after restore but absent from the manifest.
  while IFS='|' read -r name got; do
    if ! awk -F'|' -v t="$name" '$1==t {found=1} END {exit !found}' "$manifest"; then
      printf '%-48s %12s %12s  %s\n' "$name" "-" "$got" UNEXPECTED; bad=1
    fi
  done <"$actual"
  rm -f "$actual"
  if (( bad )); then log "row counts DO NOT match the manifest"; return 1; fi
  log "all $tables tables match the manifest row counts"
}

case $mode in
  drill)
    apply_roles
    trap '[[ $keep == --keep ]] || dropdb --if-exists --force --maintenance-db=postgres "$DRILL_DB" >/dev/null 2>&1 || true' EXIT
    restore_into "$DRILL_DB"
    verify_counts "$DRILL_DB"
    if [[ $keep == --keep ]]; then
      log "kept database '$DRILL_DB' for inspection (drop it with: dropdb --force $DRILL_DB)"
    fi
    log "drill PASSED"
    ;;
  replace)
    apply_roles
    restore_into "$LIVE_DB"
    verify_counts "$LIVE_DB"
    log "live database '$LIVE_DB' restored"
    ;;
esac
