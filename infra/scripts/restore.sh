#!/usr/bin/env bash
# Restore a Homebase database dump, and prove that it restored completely.
# Runs on the server (bash 3.2 compatible).
#
#   restore.sh                         drill with the newest dump (safe, default)
#   restore.sh --drill [DUMP]          restore into a scratch DB, compare row counts, drop it
#   restore.sh --drill [DUMP] --keep   same, but keep homebase_restore_drill for inspection
#   restore.sh --replace DUMP          REPLACE the live database with DUMP
#
# DUMP is a homebase-YYYYMMDD-HHMMSS.dump file. If it is not already in
# ~/homebase/backups it is copied there first (the backup container only sees
# that directory).
#
# Every dump has a .counts manifest taken in the same snapshot as the dump;
# the restore passes only if every table's row count matches it exactly.
#
# --replace does, in order:
#   1. checks HOMEBASE_MASTER_KEY is present in .env (see below)
#   2. asks you to type "replace"
#   3. stops web and worker
#   4. takes a safety dump of the current live DB
#   5. re-creates roles, drops and re-creates the live DB, pg_restore, verifies counts
#   6. runs migrations, starts the stack again
#
# HOMEBASE_MASTER_KEY: every connector credential in the database is encrypted
# with it. A restored database is only useful with the SAME key that was in
# .env when the dump was taken. On a new server, paste the key from your
# password manager into ~/homebase/.env (HOMEBASE_MASTER_KEY=...) BEFORE
# running --replace. If the key is lost, the restore still works but every
# connection must be re-entered in Settings -> Connections.
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/infra/scripts/compose.sh"
BACKUPS="$ROOT/backups"

die() { echo "restore.sh: $*" >&2; exit 1; }
usage() { sed -n '2,31p' "$0"; exit "${1:-0}"; }

mode=drill
dump=""
keep=""
yes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --drill) mode=drill ;;
    --replace) mode=replace ;;
    --keep) keep=--keep ;;
    --yes-i-mean-it) yes=1 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 2 ;;
    *) [ -z "$dump" ] || die "only one dump file may be given"; dump=$1 ;;
  esac
  shift
done

[ -f "$ROOT/.env" ] || die "$ROOT/.env is missing (run infra/scripts/server-bootstrap.sh first)"

# Resolve the dump file.
if [ -z "$dump" ]; then
  [ "$mode" = drill ] || die "--replace needs an explicit dump file"
  # shellcheck disable=SC2012  # names are ours: homebase-YYYYMMDD-HHMMSS.dump
  dump=$(ls -1t "$BACKUPS"/homebase-*.dump 2>/dev/null | head -n1 || true)
  [ -n "$dump" ] || die "no dumps found in $BACKUPS"
fi
[ -f "$dump" ] || die "no such file: $dump"
dump_dir="$(cd "$(dirname "$dump")" && pwd)"
dump_name="$(basename "$dump")"
case "$dump_name" in *.dump) ;; *) die "expected a .dump file, got $dump_name" ;; esac
stem="${dump_name%.dump}"

if [ "$dump_dir" != "$BACKUPS" ]; then
  mkdir -p "$BACKUPS/imported"
  ( umask 077
    for ext in dump counts roles.sql; do
      if [ -f "$dump_dir/$stem.$ext" ]; then cp -p "$dump_dir/$stem.$ext" "$BACKUPS/imported/"; fi
    done )
  rel="imported/$dump_name"
  echo "Copied $dump_name (and its manifest) into $BACKUPS/imported/"
else
  rel="$dump_name"
fi
[ -f "$BACKUPS/${rel%.dump}.counts" ] || echo "WARNING: no .counts manifest next to $dump_name; row counts cannot be verified."

# Master key presence check. Never prints the key.
key_line=$(grep -E '^HOMEBASE_MASTER_KEY=' "$ROOT/.env" | tail -n1 || true)
key_value=${key_line#HOMEBASE_MASTER_KEY=}
if [ -z "$key_value" ]; then
  key_status=missing
else
  key_status=present
fi
unset key_line key_value

echo "== Homebase restore: mode=$mode dump=$rel"
"$COMPOSE" up -d --wait postgres >/dev/null
"$COMPOSE" up -d backup >/dev/null

if [ "$mode" = drill ]; then
  # shellcheck disable=SC2086  # $keep is empty or --keep
  "$COMPOSE" exec -T backup bash /backup/pgrestore.sh drill "/backups/$rel" $keep
  echo
  echo "Drill passed: the dump restores cleanly and every table's row count matches."
  if [ "$key_status" = present ]; then
    echo "HOMEBASE_MASTER_KEY is present in .env. Also confirm it matches the copy in your password manager:"
    echo "  the restore test (spec 4.6) is only complete when BOTH the DB and the key are recoverable."
  else
    echo "WARNING: HOMEBASE_MASTER_KEY is EMPTY in .env. Encrypted credentials in this backup cannot be read."
  fi
  exit 0
fi

# ---- replace ---------------------------------------------------------------
if [ "$key_status" = missing ]; then
  echo "HOMEBASE_MASTER_KEY is empty in $ROOT/.env."
  echo "Paste the key from your password manager into .env first (the one in use when this dump was taken)."
  echo "Continuing without it means every saved connection must be re-entered afterwards."
fi
echo
echo "This will DROP the live 'homebase' database and replace it with $dump_name."
echo "A safety dump of the current database is taken first."
if [ -z "$yes" ]; then
  [ -r /dev/tty ] || die "no terminal to confirm on; re-run interactively (or pass --yes-i-mean-it)"
  printf 'Type "replace" to continue: ' >/dev/tty
  read -r answer </dev/tty
  [ "$answer" = replace ] || die "aborted"
fi

echo "== Stopping web and worker"
"$COMPOSE" stop web worker >/dev/null 2>&1 || true

echo "== Safety dump of the current database"
"$COMPOSE" exec -T backup bash /backup/pgdump.sh once | tail -n1

echo "== Restoring"
"$COMPOSE" exec -T backup bash /backup/pgrestore.sh replace "/backups/$rel"

echo "== Running migrations (re-applies role passwords and any newer migrations)"
"$COMPOSE" run --rm migrate

echo "== Starting the stack"
"$COMPOSE" up -d --remove-orphans
echo
echo "Restore complete. Check the app (Settings -> Connections should show your saved connections)."
echo "If connections show as unreadable, HOMEBASE_MASTER_KEY in .env is not the key this backup was made with."
