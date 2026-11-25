#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the Homebase checkout on the server.
# Runs ON the server as the normal user (macOS /bin/bash 3.2 is fine). Never uses sudo, never changes macOS
# settings: anything that needs sudo is PRINTED for you to run yourself.
#
# From the dev machine, before the repo is on the server:
#   ssh homebase-server 'bash -s' < infra/scripts/server-bootstrap.sh
# Or on the server, once cloned:
#   bash ~/homebase/infra/scripts/server-bootstrap.sh
#
# What it does (each step is skipped if already done):
#   1. checks for git, Docker (OrbStack) and openssl
#   2. clones github.com/JoeyDesai/homebase to ~/homebase (override: HOMEBASE_REPO=owner/name, HOMEBASE_DIR)
#      using, in order: gh CLI auth, a read-only deploy key at
#      ~/.ssh/homebase_github_deploy, or anonymous HTTPS if the repo is public.
#      If none works it creates the deploy key, prints the public half and
#      exits; add it on GitHub (read-only) and re-run.
#   3. creates .env from .env.example (chmod 600) and fills in random
#      POSTGRES_PASSWORD, HOMEBASE_RO_PASSWORD and HOMEBASE_MASTER_KEY if they
#      are empty or CHANGE_ME. The master key is printed ONCE, when generated.
#   4. creates ~/homebase/backups (chmod 700)
#   5. prints the power-management (pmset) commands still needed, and other
#      manual steps (TS_AUTHKEY, OrbStack start at login, whisper)
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
umask 077

REPO_SLUG=${HOMEBASE_REPO:-JoeyDesai/homebase}
REPO_DIR=${HOMEBASE_DIR:-$HOME/homebase}
DEPLOY_KEY="$HOME/.ssh/homebase_github_deploy"
GITHUB_ED25519='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

step() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   WARNING: %s\n' "$*"; }
die()  { printf '\nbootstrap: %s\n' "$*" >&2; exit 1; }

todo_file=$(mktemp)
trap 'rm -f "$todo_file"' EXIT
todo() { printf '%s\n' "$*" >>"$todo_file"; }

# --------------------------------------------------------------------- 1. tools
step "Checking tools"
[ "$(uname -s)" = Darwin ] || warn "this script is written for macOS; continuing anyway"
if xcode-select -p >/dev/null 2>&1 || [ -x /opt/homebrew/bin/git ] || [ -x /usr/local/bin/git ]; then
  info "git: $(git --version)"
else
  die "git needs the Xcode Command Line Tools. On the server run: xcode-select --install   (then re-run this script)"
fi
command -v openssl >/dev/null || die "openssl not found"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  info "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null) ($(docker context show 2>/dev/null || echo '?'))"
  have_docker=1
else
  have_docker=0
  warn "Docker engine not reachable. Install/open OrbStack (https://orbstack.dev) on the server."
  todo "Install OrbStack and open it once; enable OrbStack > Settings > 'Start at login'."
fi

# --------------------------------------------------------------------- 2. repo
ensure_github_known_host() {
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/known_hosts"; chmod 600 "$HOME/.ssh/known_hosts"
  if ! ssh-keygen -F github.com -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
    # GitHub's published ed25519 host key (https://api.github.com/meta).
    printf '%s\n' "$GITHUB_ED25519" >>"$HOME/.ssh/known_hosts"
    info "added GitHub's published host key to ~/.ssh/known_hosts"
  fi
}

ssh_cmd="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"

step "Repository at $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  info "already cloned: $(git -C "$REPO_DIR" remote get-url origin 2>/dev/null) @ $(git -C "$REPO_DIR" log -1 --format='%h %s')"
else
  if [ -e "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]; then
    die "$REPO_DIR exists and is not a git checkout; move it aside first"
  fi
  cloned=0
  if [ "$cloned" = 0 ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    info "cloning with gh"
    gh repo clone "$REPO_SLUG" "$REPO_DIR" </dev/null && cloned=1
  fi
  if [ "$cloned" = 0 ] && [ -f "$DEPLOY_KEY" ]; then
    ensure_github_known_host
    info "cloning with deploy key $DEPLOY_KEY"
    if GIT_SSH_COMMAND="$ssh_cmd" git clone "git@github.com:$REPO_SLUG.git" "$REPO_DIR" </dev/null; then
      git -C "$REPO_DIR" config core.sshCommand "$ssh_cmd"
      cloned=1
    else
      warn "clone with the deploy key failed (has the key been added to the repo on GitHub yet?)"
    fi
  fi
  if [ "$cloned" = 0 ] && GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$REPO_SLUG.git" </dev/null >/dev/null 2>&1; then
    info "repo is publicly readable; cloning over HTTPS"
    GIT_TERMINAL_PROMPT=0 git clone "https://github.com/$REPO_SLUG.git" "$REPO_DIR" </dev/null && cloned=1
  fi
  if [ "$cloned" = 0 ]; then
    if [ ! -f "$DEPLOY_KEY" ]; then
      mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
      ssh-keygen -q -t ed25519 -N '' -C "homebase-server-deploy-$(hostname -s)" -f "$DEPLOY_KEY" </dev/null
      info "created a new deploy key: $DEPLOY_KEY"
    fi
    cat <<EOF

   The server cannot read github.com/$REPO_SLUG yet. Add this PUBLIC key as a
   read-only deploy key (do NOT tick "Allow write access"):

     https://github.com/$REPO_SLUG/settings/keys  ->  Add deploy key
     Title: homebase-server

$(sed 's/^/     /' "$DEPLOY_KEY.pub")

   Then run this script again.
EOF
    exit 3
  fi
  info "cloned to $REPO_DIR"
fi
cd "$REPO_DIR"

# --------------------------------------------------------------------- 3. .env
ENV_FILE="$REPO_DIR/.env"

get_env() {  # value of KEY in .env (last occurrence), quotes stripped; never printed by callers
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

set_env() {  # KEY VALUE: replace (or append) KEY=VALUE without the value appearing in argv
  local tmp
  tmp=$(mktemp "$REPO_DIR/.env.XXXXXX")
  HB_KEY="$1" HB_VAL="$2" awk '
    BEGIN { k = ENVIRON["HB_KEY"]; v = ENVIRON["HB_VAL"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

is_placeholder() { [ -z "$1" ] || [ "$1" = CHANGE_ME ]; }

pgdata_exists=0
if [ "$have_docker" = 1 ] && docker volume inspect homebase_pgdata >/dev/null 2>&1; then
  pgdata_exists=1
fi

step "Secrets file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$REPO_DIR/.env.example" ] || die ".env.example missing from the checkout"
  cp "$REPO_DIR/.env.example" "$ENV_FILE"
  info "created .env from .env.example"
fi
chmod 600 "$ENV_FILE"
info "permissions: $(stat -f '%Sp' "$ENV_FILE")"

master_key_generated=""

pg_pw=$(get_env POSTGRES_PASSWORD)
if is_placeholder "$pg_pw"; then
  if [ "$pgdata_exists" = 1 ]; then
    die "POSTGRES_PASSWORD is empty but the Docker volume homebase_pgdata already exists,
   so Postgres was initialised with some earlier password. Put that password in .env
   (POSTGRES_PASSWORD=... and inside DATABASE_URL), or restore from a backup. Not generating one."
  fi
  pg_pw=$(openssl rand -hex 24)
  set_env POSTGRES_PASSWORD "$pg_pw"
  info "generated POSTGRES_PASSWORD"
else
  info "POSTGRES_PASSWORD already set"
fi

db_url=$(get_env DATABASE_URL)
case "$db_url" in
  ""|*CHANGE_ME*)
    set_env DATABASE_URL "postgres://homebase:${pg_pw}@postgres:5432/homebase"
    info "set DATABASE_URL to match POSTGRES_PASSWORD" ;;
  *"$pg_pw"*) info "DATABASE_URL already set" ;;
  *) warn "DATABASE_URL does not contain POSTGRES_PASSWORD; check they match (not changing it)" ;;
esac

ro_pw=$(get_env HOMEBASE_RO_PASSWORD)
if is_placeholder "$ro_pw"; then
  set_env HOMEBASE_RO_PASSWORD "$(openssl rand -hex 24)"
  info "generated HOMEBASE_RO_PASSWORD"
else
  info "HOMEBASE_RO_PASSWORD already set"
fi
unset ro_pw

mk=$(get_env HOMEBASE_MASTER_KEY)
if is_placeholder "$mk"; then
  if [ "$pgdata_exists" = 1 ]; then
    die "HOMEBASE_MASTER_KEY is empty but a database already exists (volume homebase_pgdata).
   Credentials in it were encrypted with the ORIGINAL key: paste it from your password
   manager into $ENV_FILE as HOMEBASE_MASTER_KEY=... and re-run. Not generating a new one."
  fi
  mk=$(openssl rand -base64 32)
  set_env HOMEBASE_MASTER_KEY "$mk"
  master_key_generated=1
  info "generated HOMEBASE_MASTER_KEY"
else
  info "HOMEBASE_MASTER_KEY already set"
fi
unset pg_pw db_url

# The public demo's own secrets (demo-postgres, demo-seed, demo-web; never the real ones). Compose refuses
# to run any command while they're empty, even if the demo services are never started.
demo_pgdata_exists=0
if [ "$have_docker" = 1 ] && docker volume inspect homebase_demo-pgdata >/dev/null 2>&1; then
  demo_pgdata_exists=1
fi
if is_placeholder "$(get_env DEMO_POSTGRES_PASSWORD)"; then
  if [ "$demo_pgdata_exists" = 1 ]; then
    warn "DEMO_POSTGRES_PASSWORD is empty but the volume homebase_demo-pgdata exists; put its password back in .env (not generating one)"
  else
    set_env DEMO_POSTGRES_PASSWORD "$(openssl rand -hex 24)"
    info "generated DEMO_POSTGRES_PASSWORD"
  fi
else
  info "DEMO_POSTGRES_PASSWORD already set"
fi
if is_placeholder "$(get_env DEMO_MASTER_KEY)"; then
  set_env DEMO_MASTER_KEY "$(openssl rand -base64 32)"
  info "generated DEMO_MASTER_KEY (demo data only; no need to save it)"
else
  info "DEMO_MASTER_KEY already set"
fi

if [ -z "$(get_env TS_AUTHKEY)" ]; then
  todo "Put the Tailscale auth key (reusable, tagged tag:homebase) in $ENV_FILE as TS_AUTHKEY=... (edit on the server: nano $ENV_FILE). Never paste it into chat."
fi
chmod 600 "$ENV_FILE"

# --------------------------------------------------------------------- 4. dirs
step "Backups directory"
mkdir -p "$REPO_DIR/backups"
chmod 700 "$REPO_DIR/backups"
info "$REPO_DIR/backups (mode $(stat -f '%Lp' "$REPO_DIR/backups"))"

# --------------------------------------------------------------------- 5. power
step "Power settings (read-only check)"
pm=$(pmset -g 2>/dev/null || true)
pm_val() { printf '%s\n' "$pm" | awk -v k="$1" '$1 == k { print $2; exit }'; }
need=""
[ "$(pm_val sleep)" = 0 ]       || need="$need sleep 0"
[ "$(pm_val disksleep)" = 0 ]   || need="$need disksleep 0"
[ "$(pm_val autorestart)" = 1 ] || need="$need autorestart 1"
[ "$(pm_val womp)" = 1 ]        || need="$need womp 1"
if [ -n "$need" ]; then
  info "not yet set:$need"
  todo "Keep the server awake and auto-restarting after power loss. On the server, run:  sudo pmset -a$need"
else
  info "sleep 0, disksleep 0, autorestart 1, womp 1: already set"
fi
if [ "$(pm_val SleepDisabled)" != 1 ]; then
  todo "If the server is a laptop that will run with its LID CLOSED and no external display, also run:  sudo pmset -a disablesleep 1"
fi

# --------------------------------------------------------------------- 6. other checks
if ! [ -f "$HOME/Library/LaunchAgents/com.homebase.whisper.plist" ]; then
  todo "Install speech-to-text (Homebrew whisper.cpp, Metal):  bash $REPO_DIR/infra/scripts/install-whisper.sh"
fi
autologin=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
if [ "$autologin" != "$(id -un)" ]; then
  todo "Enable automatic login for '$(id -un)' (System Settings > Users & Groups > Automatically log in as) so OrbStack and whisper start after a power cut. Requires FileVault off; see docs/server-setup.md."
fi

# --------------------------------------------------------------------- master key banner
if [ -n "$master_key_generated" ]; then
  cat <<EOF

################################################################################
#                                                                              #
#   HOMEBASE MASTER KEY: SAVE THIS IN YOUR PASSWORD MANAGER NOW                #
#                                                                              #
#   It encrypts every saved bank/API credential. Without it, a restored        #
#   backup cannot read any of them. It is shown only this once.                #
#   (It also lives in $ENV_FILE as HOMEBASE_MASTER_KEY.)
#                                                                              #
################################################################################

    HOMEBASE_MASTER_KEY=$mk

  Save it as a password-manager item named "Homebase master key", then clear
  this terminal's scrollback (macOS Terminal: Cmd-K).

EOF
fi
unset mk

# --------------------------------------------------------------------- summary
step "Next steps"
if [ -s "$todo_file" ]; then
  n=1
  while IFS= read -r line; do
    printf '   %d. %s\n' "$n" "$line"
    n=$((n + 1))
  done <"$todo_file"
else
  info "nothing left to do here."
fi
info "Then deploy from the dev machine:  infra/scripts/deploy.sh"
