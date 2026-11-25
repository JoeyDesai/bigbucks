#!/usr/bin/env bash
# Runs INSIDE the `backup` container (postgres:18 image). Not for the host.
#
#   pgdump.sh loop   # default: dump daily at $BACKUP_AT ($TZ), forever
#   pgdump.sh once   # one dump now, then rotate; prints the dump path
#
# Each run writes, in $BACKUP_DIR:
#   homebase-YYYYMMDD-HHMMSS.dump        pg_dump -Fc of $PGDATABASE
#   homebase-YYYYMMDD-HHMMSS.counts      "schema.table|rows" taken in the SAME snapshot as the dump
#   homebase-YYYYMMDD-HHMMSS.roles.sql   cluster roles (no passwords), needed to restore GRANTs
#   .last-success / .last-failure        status markers (read by the worker / health page)
#
# Connection settings come from libpq env vars (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
set -euo pipefail
umask 077

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_AT=${BACKUP_AT:-03:30}
RETENTION_DAYS=${RETENTION_DAYS:-30}
PREFIX=homebase

# Fall back to a POSIX TZ rule if the image has no zoneinfo for $TZ.
if [[ ! -e "/usr/share/zoneinfo/${TZ:-America/New_York}" ]]; then
  export TZ='EST5EDT,M3.2.0,M11.1.0'
fi

# Logs go to stderr (the container log); stdout carries only the dump path in `once` mode.
log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }

# psql must not block-buffer its output when talking to us through a pipe.
PSQL=(psql -X -q -At -v ON_ERROR_STOP=1)
if command -v stdbuf >/dev/null 2>&1; then PSQL=(stdbuf -oL -eL "${PSQL[@]}"); fi

# Generates one "SELECT 'schema.table|' || count(*)" per user table and runs them (\gexec).
read -r -d '' COUNT_SQL <<'SQL' || true
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

# Close the FIFO-backed psql session opened in dump_once.
close_session() {
  local pid=$1 dir=$2
  { exec 7>&- 8<&-; } 2>/dev/null || true
  # Give psql a moment to COMMIT and exit on EOF, then make sure it is gone.
  local _
  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$dir"
  trap - PIPE
}

dump_once() {
  mkdir -p "$BACKUP_DIR"
  local stamp base tmp counts_tmp roles_tmp
  stamp=$(date +%Y%m%d-%H%M%S)
  base="$BACKUP_DIR/$PREFIX-$stamp"
  tmp="$base.dump.partial"
  counts_tmp="$base.counts.partial"
  roles_tmp="$base.roles.sql.partial"

  # 1. Open a REPEATABLE READ transaction in a long-lived psql session (talked
  #    to through two FIFOs on fds 7/8) and export its snapshot, so the dump
  #    and the row counts see exactly the same data.
  local fifo_dir
  fifo_dir=$(mktemp -d)
  mkfifo "$fifo_dir/in" "$fifo_dir/out"
  "${PSQL[@]}" <"$fifo_dir/in" >"$fifo_dir/out" 2>&1 &
  local pid=$!
  exec 7>"$fifo_dir/in" 8<"$fifo_dir/out"
  # If psql dies, writes to it must fail with EPIPE (handled below), not kill us.
  trap '' PIPE

  printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;' 'SELECT pg_export_snapshot();' >&7 || true
  local snap=""
  IFS= read -r -t 60 snap <&8 || true
  if [[ ! $snap =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$ ]]; then
    log "ERROR: could not export a snapshot (psql said: ${snap:-nothing})"
    close_session "$pid" "$fifo_dir"
    return 1
  fi

  # 2. Dump using that snapshot.
  if ! pg_dump -Fc --snapshot="$snap" -f "$tmp"; then
    log "ERROR: pg_dump failed"
    close_session "$pid" "$fifo_dir"
    rm -f "$tmp"
    return 1
  fi

  # 3. Exact row counts in the same snapshot.
  printf '%s\n' "$COUNT_SQL" "SELECT '__homebase_end__';" >&7 || true
  : >"$counts_tmp"
  local line got_end=0
  while IFS= read -r -t 600 line <&8; do
    if [[ $line == "__homebase_end__" ]]; then got_end=1; break; fi
    printf '%s\n' "$line" >>"$counts_tmp"
  done
  printf '%s\n' 'COMMIT;' '\q' >&7 2>/dev/null || true
  close_session "$pid" "$fifo_dir"
  if (( got_end == 0 )); then
    log "ERROR: row-count query did not complete: $(tail -n 3 "$counts_tmp" | tr '\n' ' ')"
    rm -f "$tmp" "$counts_tmp"
    return 1
  fi

  # 4. Roles (no password hashes): lets a restore onto a fresh server re-create
  #    GRANT targets such as homebase_ro before pg_restore runs.
  if ! pg_dumpall --roles-only --no-role-passwords -f "$roles_tmp"; then
    log "WARN: pg_dumpall --roles-only failed; continuing without a roles file"
    rm -f "$roles_tmp"
  fi

  # 5. Sanity-check the archive is readable before declaring success.
  if ! pg_restore --list "$tmp" >/dev/null; then
    log "ERROR: pg_restore --list could not read $tmp"
    rm -f "$tmp" "$counts_tmp" "$roles_tmp"
    return 1
  fi

  mv "$tmp" "$base.dump"
  mv "$counts_tmp" "$base.counts"
  [[ -f $roles_tmp ]] && mv "$roles_tmp" "$base.roles.sql"
  chmod 600 "$base".* 2>/dev/null || true

  local size tables
  size=$(du -h "$base.dump" | cut -f1)
  tables=$(wc -l <"$base.counts" | tr -d ' ')
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(basename "$base.dump")" >"$BACKUP_DIR/.last-success"
  rm -f "$BACKUP_DIR/.last-failure"
  log "OK $(basename "$base.dump") ($size, $tables tables)"
  rotate
  printf '%s\n' "$base.dump"
}

# Delete dumps older than RETENTION_DAYS, but never the newest dump, and
# clean up stale .partial files from interrupted runs.
rotate() {
  local newest
  newest=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.dump" -printf '%T@ %p\n' | sort -rn | awk 'NR == 1 { l = $0 } END { sub(/^[^ ]+ /, "", l); print l }')
  local max_age_min=$(( RETENTION_DAYS * 24 * 60 ))
  local f stem
  while IFS= read -r -d '' f; do
    [[ $f == "$newest" ]] && continue
    stem=${f%.dump}
    rm -f "$f" "$stem.counts" "$stem.roles.sql"
    log "rotated $(basename "$f")"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.dump" -mmin "+$max_age_min" -print0)
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.partial" -mmin +1440 -delete 2>/dev/null || true
}

next_run_epoch() {
  local now today
  now=$(date +%s)
  today=$(date -d "today $BACKUP_AT" +%s)
  if (( today > now )); then echo "$today"; else date -d "tomorrow $BACKUP_AT" +%s; fi
}

run_and_record() {
  if ! dump_once >/dev/null; then
    printf '%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$BACKUP_DIR/.last-failure"
    log "backup FAILED; will retry at the next scheduled time"
  fi
}

loop() {
  trap 'log "stopping"; exit 0' TERM INT
  mkdir -p "$BACKUP_DIR"
  log "daily at $BACKUP_AT ($(date +%Z)), keeping $RETENTION_DAYS days, into $BACKUP_DIR"

  # Catch up if the last good dump is more than 26 h old (e.g. the Mac was off at 03:30).
  if [[ -f "$BACKUP_DIR/.last-success" ]]; then
    local age last
    last=$(stat -c %Y "$BACKUP_DIR/.last-success")
    age=$(( $(date +%s) - last ))
    if (( age > 26 * 3600 )); then
      log "last successful backup is $(( age / 3600 )) h old; running one now"
      run_and_record
    fi
  fi

  local target now
  while true; do
    target=$(next_run_epoch)
    log "next backup at $(date -d "@$target" '+%Y-%m-%d %H:%M %Z')"
    while now=$(date +%s); (( now < target )); do
      # Short sleeps so a clock jump (host sleep/resume) does not skip a day.
      sleep $(( target - now < 300 ? target - now : 300 )) &
      wait $! || true
    done
    run_and_record
  done
}

case "${1:-loop}" in
  loop) loop ;;
  once) dump_once ;;
  *) echo "usage: $0 [loop|once]" >&2; exit 2 ;;
esac
