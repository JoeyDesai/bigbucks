#!/usr/bin/env bash
# Run `docker compose` for the Homebase stack with the repo-root .env.
# Usage (on the server, from anywhere):  ~/homebase/infra/scripts/compose.sh ps
set -euo pipefail
# Non-interactive SSH shells on macOS do not load OrbStack/Homebrew paths.
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ ! -f "$ROOT/.env" ]; then
  echo "compose.sh: $ROOT/.env is missing. Run infra/scripts/server-bootstrap.sh first." >&2
  exit 1
fi
mkdir -p "$ROOT/backups"
exec docker compose \
  --project-name homebase \
  --project-directory "$ROOT/infra" \
  --env-file "$ROOT/.env" \
  -f "$ROOT/infra/docker-compose.yml" \
  "$@"
