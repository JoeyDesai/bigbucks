#!/usr/bin/env bash
# Deploy Homebase to the home server. Run this on the DEV machine.
#
#   infra/scripts/deploy.sh [--host homebase-server] [--branch main] [--no-pull]
#
# Steps (on the server, over SSH):
#   1. git pull --ff-only in ~/homebase (refuses if the server checkout has local edits)
#   2. docker compose build
#   3. start postgres, run migrations (one-shot `migrate` service)
#   4. docker compose up -d (tailscale, web, worker, backup)
#   5. health check: wait for the web container to report healthy, then GET
#      /api/health from inside its network namespace; show Tailscale Serve status
#
# The server pulls from GitHub, so push your commits first. Needs the
# `homebase-server` SSH host alias (docs/server-setup.md step 3).
set -euo pipefail

HOST=homebase-server
BRANCH=main
PULL=1
# shellcheck disable=SC2088  # expanded by the server's shell, not here
REMOTE_DIR='~/homebase'

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift ;;
    --branch) BRANCH=$2; shift ;;
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Local sanity checks: warn if the server would deploy something other than what you have.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "note: you have uncommitted local changes; they will NOT be deployed."
  fi
  git fetch --quiet origin "$BRANCH" 2>/dev/null || true
  if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
    ahead=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
    if [ "$ahead" != 0 ]; then
      echo "note: HEAD is $ahead commit(s) ahead of origin/$BRANCH; push first if you want them deployed."
    fi
  fi
fi

echo "== Deploying $BRANCH to $HOST"
# shellcheck disable=SC2029  # REMOTE_DIR is meant to expand on the server
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  "bash -s -- $REMOTE_DIR '$BRANCH' '$PULL'" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR=$1 BRANCH=$2 PULL=$3

[ -d "$DIR/.git" ] || { echo "server: $DIR is not a git checkout; run infra/scripts/server-bootstrap.sh on the server first" >&2; exit 1; }
cd "$DIR"
[ -f .env ] || { echo "server: $DIR/.env missing; run infra/scripts/server-bootstrap.sh" >&2; exit 1; }
chmod 600 .env
command -v docker >/dev/null || { echo "server: docker not found (is OrbStack installed and running?)" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "server: Docker engine not responding; open OrbStack on the server" >&2; exit 1; }

if [ "$PULL" = 1 ]; then
  echo "== git pull ($BRANCH)"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "server: the checkout in $DIR has local modifications; refusing to pull." >&2
    git status --short >&2
    exit 1
  fi
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet "$BRANCH"
  git merge --ff-only --quiet "origin/$BRANCH"
fi
echo "   at $(git log -1 --format='%h %s')"

C="$DIR/infra/scripts/compose.sh"

echo "== Building images"
"$C" build --pull

echo "== Starting postgres"
"$C" up -d --wait --wait-timeout 120 postgres

echo "== Running migrations"
"$C" run --rm -T migrate </dev/null

echo "== Starting the stack"
"$C" up -d --remove-orphans

echo "== Health check"
web_id=$("$C" ps -q web)
[ -n "$web_id" ] || { echo "server: web container is not running" >&2; "$C" ps -a; exit 1; }
status=unknown
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$web_id" 2>/dev/null || echo gone)
  case "$status" in
    healthy) break ;;
    unhealthy|exited|dead|gone) break ;;
  esac
  sleep 3
done
echo "   web container: $status"
if ! "$C" exec -T web node -e '
  fetch("http://" + (process.env.HOSTNAME || "127.0.0.2") + ":" + (process.env.PORT || 3000) + "/api/health")
    .then(async r => { console.log("   GET /api/health ->", r.status, (await r.text()).slice(0, 300)); process.exit(r.ok ? 0 : 1); })
    .catch(e => { console.error("   GET /api/health failed:", e.message); process.exit(1); })'; then
  echo "server: health check FAILED. Recent web logs:" >&2
  "$C" logs --tail 80 web >&2 || true
  exit 1
fi

worker_id=$("$C" ps -q worker)
if [ -n "$worker_id" ]; then
  echo "   worker container: $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$worker_id")"
else
  echo "   WARNING: worker is not running"; "$C" logs --tail 40 worker || true
fi

echo "== Tailscale"
if "$C" exec -T tailscale tailscale status --self=true --peers=false 2>/dev/null; then
  "$C" exec -T tailscale tailscale serve status 2>/dev/null || true
  dns=$("$C" exec -T tailscale tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | sed -E 's/.*"DNSName": *"([^"]*)\.?".*/\1/' || true)
  [ -n "$dns" ] && echo "   URL: https://${dns%.}/"
else
  echo "   tailscale is not logged in yet. Put TS_AUTHKEY in .env, then: infra/scripts/compose.sh up -d tailscale"
fi
"$C" ps
echo "== Deploy OK"
REMOTE
