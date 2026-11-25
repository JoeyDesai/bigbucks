#!/usr/bin/env bash
# READ-ONLY inventory of the home server. Changes nothing, needs no sudo.
#
# From the dev machine (the repo does not need to be on the server yet):
#   ssh homebase-server 'bash -s' < infra/scripts/server-inventory.sh | tee server-inventory.txt
# On the server:
#   bash ~/homebase/infra/scripts/server-inventory.sh
#
# Reports: macOS version and hardware, disk, power settings, FileVault and
# auto-login, OrbStack/Docker and running containers, Tailscale (account,
# tailnet, MagicDNS, tags), listening ports, Homebrew services, any extra
# processes you name in INVENTORY_PROCESSES, and whether Homebase/whisper are
# already installed.
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$PATH"
export LC_ALL=C

section() { printf '\n==== %s ====\n' "$*"; }
# Run a command, never abort the report if it fails or is missing.
try() {
  if command -v "$1" >/dev/null 2>&1; then
    "$@" 2>&1 || echo "(exit $? from: $*)"
  else
    echo "($1: not installed)"
  fi
}

section "Host"
echo "date:      $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "user:      $(id -un) (uid $(id -u))"
echo "hostname:  $(hostname)"
echo "computer:  $(scutil --get ComputerName 2>/dev/null || echo '?')  local: $(scutil --get LocalHostName 2>/dev/null || echo '?').local"
try sw_vers
echo "arch:      $(uname -m)"
sysctl -n machdep.cpu.brand_string 2>/dev/null || true
echo "memory:    $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB"
system_profiler SPHardwareDataType 2>/dev/null | grep -E 'Model Name|Model Identifier|Chip|Memory' || true
try uptime

section "Disk"
df -h / /System/Volumes/Data 2>/dev/null || df -h /
diskutil info / 2>/dev/null | grep -E 'Volume Name|File System Personality|Container Free Space|Volume Free Space|Solid State' || true

section "Power (pmset -g)"
try pmset -g
section "Power: battery / AC"
try pmset -g batt
section "Power: scheduled events"
try pmset -g sched

section "FileVault / auto-login / firewall"
fdesetup status 2>/dev/null || echo "(fdesetup status unavailable)"
autologin=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
echo "auto-login user: ${autologin:-<none>}"
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null || true
/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>/dev/null || true

section "Network"
for ifc in en0 en1; do
  ip=$(ipconfig getifaddr "$ifc" 2>/dev/null || true)
  [ -n "$ip" ] && echo "$ifc: $ip"
done
route -n get default 2>/dev/null | grep -E 'gateway|interface' || true

section "OrbStack / Docker"
if [ -d /Applications/OrbStack.app ]; then
  echo "OrbStack.app: installed ($(defaults read /Applications/OrbStack.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '?'))"
else
  echo "OrbStack.app: not in /Applications"
fi
[ -d /Applications/Docker.app ] && echo "Docker Desktop.app: installed (should not run alongside OrbStack)"
if command -v orb >/dev/null 2>&1; then
  echo "orb status: $(orb status 2>&1 || true)"
fi
if command -v docker >/dev/null 2>&1; then
  docker version --format 'docker client {{.Client.Version}}, server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})' 2>&1 || echo "(docker engine not reachable)"
  docker compose version 2>&1 || true
  echo
  echo "-- running containers"
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true
  echo
  echo "-- stopped containers"
  docker ps -a --filter status=exited --filter status=created --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1 || true
  echo
  echo "-- compose projects"
  docker compose ls -a 2>&1 || true
  echo
  echo "-- volumes"
  docker volume ls 2>&1 || true
  echo
  echo "-- disk usage"
  docker system df 2>&1 || true
else
  echo "docker CLI: not found"
fi
echo "OrbStack 'Start at login': check OrbStack > Settings > General (not readable from a script)"

section "Tailscale"
ts=""
if command -v tailscale >/dev/null 2>&1; then
  ts=$(command -v tailscale)
elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
if [ -n "$ts" ]; then
  echo "tailscale CLI: $ts"
  "$ts" version 2>&1 | head -n1 || true
  echo "-- status"
  "$ts" status 2>&1 | head -n 60 || true
  json=$("$ts" status --json 2>/dev/null || true)
  if [ -n "$json" ]; then
    tmpj=$(mktemp)
    printf '%s' "$json" >"$tmpj"
    get() { plutil -extract "$1" raw -o - "$tmpj" 2>/dev/null || echo '?'; }
    echo "-- this node"
    echo "BackendState:    $(get BackendState)"
    echo "Tailnet:         $(get CurrentTailnet.Name)"
    echo "MagicDNSSuffix:  $(get CurrentTailnet.MagicDNSSuffix)"
    echo "MagicDNSEnabled: $(get CurrentTailnet.MagicDNSEnabled)"
    echo "Self DNSName:    $(get Self.DNSName)"
    echo "Self UserID:     $(get Self.UserID)"
    echo "Self Tags:       $(plutil -extract Self.Tags json -o - "$tmpj" 2>/dev/null || echo '<none>')"
    echo "CertDomains:     $(plutil -extract CertDomains json -o - "$tmpj" 2>/dev/null || echo '<none: HTTPS certs may be disabled>')"
    rm -f "$tmpj"
  fi
  self_ip=$("$ts" ip -4 2>/dev/null | head -n1 || true)
  if [ -n "$self_ip" ]; then
    echo "-- whois $self_ip (which account owns this node)"
    "$ts" whois "$self_ip" 2>&1 | head -n 20 || true
  fi
  echo "-- serve status"
  "$ts" serve status 2>&1 | head -n 30 || true
else
  echo "Tailscale: not installed (no CLI on PATH, no /Applications/Tailscale.app)"
fi

section "Listening TCP ports (this user's processes; system daemons need sudo to see)"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==1 || !seen[$1 FS $9]++' || true
section "All listening sockets (netstat, no process names)"
netstat -anv -p tcp 2>/dev/null | awk 'NR<=2 || /LISTEN/' | awk '{print $4}' | sort -u | head -n 60 || true

section "Known services"
for p in whisper-server ${INVENTORY_PROCESSES:-}; do
  pids=$(pgrep -fl "$p" 2>/dev/null | grep -v pgrep | head -n 3 || true)
  [ -n "$pids" ] && printf '%s:\n%s\n' "$p" "$pids"
done
if command -v curl >/dev/null 2>&1; then
  printf 'whisper 127.0.0.1:8178  -> %s\n' "$(curl -s -m 2 http://127.0.0.1:8178/health 2>/dev/null || echo 'no answer')"
fi

section "launchd agents (user)"
launchctl list 2>/dev/null | grep -v -E '^\S+\s+\S+\s+com\.apple\.' | head -n 40 || true
ls -1 "$HOME/Library/LaunchAgents" 2>/dev/null || true

section "Homebrew"
if command -v brew >/dev/null 2>&1; then
  echo "prefix: $(brew --prefix)"
  echo "-- services"
  brew services list 2>&1 || true
  echo "-- formulae"
  brew list --formula -1 2>/dev/null | tr '\n' ' '; echo
else
  echo "Homebrew: not installed"
fi

section "Developer tools"
xcode-select -p 2>/dev/null || echo "Command Line Tools: not installed"
for t in git gh openssl curl; do printf '%-8s %s\n' "$t" "$(command -v "$t" || echo '-')"; done

section "SSH"
if [ -f "$HOME/.ssh/authorized_keys" ]; then
  echo "authorized_keys: $(grep -c -v -E '^(#|$)' "$HOME/.ssh/authorized_keys" || true) key(s)"
else
  echo "authorized_keys: none"
fi
[ -f "$HOME/.ssh/authorized_keys" ] && awk '{print "  " $1 " ... " $NF}' "$HOME/.ssh/authorized_keys"
for f in "$HOME"/.ssh/*.pub; do if [ -e "$f" ]; then echo "  pubkey: ${f##*/}"; fi; done

section "Homebase"
if [ -d "$HOME/homebase/.git" ]; then
  git -C "$HOME/homebase" log -1 --format='checkout: %h %s (%cr)' 2>/dev/null || true
  if [ -f "$HOME/homebase/.env" ]; then
    echo ".env: present, mode $(stat -f '%Lp' "$HOME/homebase/.env")"
  else
    echo ".env: missing"
  fi
  ls -1t "$HOME/homebase/backups" 2>/dev/null | head -n 5 | sed 's/^/  backup: /' || true
else
  echo "\$HOME/homebase: not cloned yet"
fi
[ -f "$HOME/Library/LaunchAgents/com.homebase.whisper.plist" ] && echo "whisper LaunchAgent: installed"
ls -1 "$HOME/Library/Application Support/homebase/whisper" 2>/dev/null | sed 's/^/  whisper model: /' || true

printf '\n==== end of inventory ====\n'
