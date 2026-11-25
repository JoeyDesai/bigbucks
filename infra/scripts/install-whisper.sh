#!/usr/bin/env bash
# Install the speech-to-text server (whisper.cpp, Metal GPU) on the server Mac.
# Runs ON the server as the normal user; no sudo. Safe to re-run.
#
#   bash ~/homebase/infra/scripts/install-whisper.sh [--model small.en|base.en] [--threads N] [--with-ffmpeg]
#
#   1. brew install whisper.cpp (the Homebrew formula formerly called whisper-cpp)
#   2. downloads the GGML model to ~/Library/Application Support/homebase/whisper
#      and checks its SHA-256
#   3. installs ~/Library/LaunchAgents/com.homebase.whisper.plist from
#      infra/launchd/com.homebase.whisper.plist: whisper-server on 127.0.0.1:8178,
#      KeepAlive, logs in ~/Library/Logs/homebase/
#   4. checks /health, runs a sample transcription, and (if the stack is up)
#      checks a container can reach it at $WHISPER_URL (http://host.internal:8178)
#
# --model base.en   smaller/faster model (use if small.en takes > 2 s per clip)
# --with-ffmpeg     also brew install ffmpeg and start the server with --convert,
#                   so it accepts iPhone audio/mp4 uploads directly. Without it,
#                   /api/stt must send 16 kHz mono WAV (or MP3/FLAC).
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$ROOT/infra/launchd/com.homebase.whisper.plist"
LABEL=com.homebase.whisper
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODEL_DIR="$HOME/Library/Application Support/homebase/whisper"
LOG_DIR="$HOME/Library/Logs/homebase"
PORT=8178

model=small.en
threads=""
with_ffmpeg=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model=$2; shift ;;
    --threads) threads=$2; shift ;;
    --with-ffmpeg) with_ffmpeg=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# SHA-256 from the Hugging Face LFS pointers (huggingface.co/ggerganov/whisper.cpp).
case "$model" in
  small.en) sha256=c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d ;;
  base.en)  sha256=a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002 ;;
  *) echo "unsupported model: $model (use small.en or base.en)" >&2; exit 2 ;;
esac
MODEL_FILE="ggml-$model.bin"
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

step() { printf '\n== %s\n' "$*"; }
die() { printf 'install-whisper: %s\n' "$*" >&2; exit 1; }

[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"
command -v brew >/dev/null 2>&1 || die "Homebrew is required (https://brew.sh)"
BREW_PREFIX=$(brew --prefix)

# ---------------------------------------------------------------- 1. packages
step "Homebrew packages"
if brew list --formula whisper.cpp >/dev/null 2>&1; then
  echo "   whisper.cpp already installed ($(brew list --versions whisper.cpp))"
else
  brew install whisper.cpp
fi
if [ "$with_ffmpeg" = 1 ]; then
  if brew list --formula ffmpeg >/dev/null 2>&1; then echo "   ffmpeg already installed"; else brew install ffmpeg; fi
fi
SERVER_BIN=${WHISPER_SERVER:-$BREW_PREFIX/bin/whisper-server}
if [ ! -x "$SERVER_BIN" ]; then
  die "whisper-server not found at $SERVER_BIN. The Homebrew bottle did not include the
  server example. Build it from source instead (needs Xcode CLT + cmake):
    git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp ~/src/whisper.cpp
    cmake -S ~/src/whisper.cpp -B ~/src/whisper.cpp/build -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
    cmake --build ~/src/whisper.cpp/build -j --target whisper-server
  then re-run with WHISPER_SERVER=~/src/whisper.cpp/build/bin/whisper-server"
fi
echo "   server binary: $SERVER_BIN"

# ---------------------------------------------------------------- 2. model
step "Model $MODEL_FILE"
mkdir -p "$MODEL_DIR" "$LOG_DIR"
check_sha() { [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$sha256" ]; }
if [ -f "$MODEL_PATH" ] && check_sha "$MODEL_PATH"; then
  echo "   already present and verified: $MODEL_PATH"
else
  echo "   downloading $MODEL_URL"
  curl -fL --retry 3 --retry-delay 5 -C - -o "$MODEL_PATH.partial" "$MODEL_URL"
  check_sha "$MODEL_PATH.partial" || { rm -f "$MODEL_PATH.partial"; die "SHA-256 mismatch for $MODEL_FILE; download removed"; }
  mv "$MODEL_PATH.partial" "$MODEL_PATH"
  echo "   verified: $MODEL_PATH"
fi

# ---------------------------------------------------------------- 3. LaunchAgent
step "LaunchAgent $PLIST"
if [ -z "$threads" ]; then
  threads=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
fi
extra=""
if [ "$with_ffmpeg" = 1 ] || [ -x "$BREW_PREFIX/bin/ffmpeg" ]; then
  extra='<string>--convert</string>'
  echo "   ffmpeg present: enabling --convert (accepts audio/mp4 from iPhone)"
fi
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
mkdir -p "$HOME/Library/LaunchAgents"
tmp_plist=$(mktemp)
sed -e "s|__WHISPER_SERVER__|$(esc "$SERVER_BIN")|g" \
    -e "s|__MODEL_PATH__|$(esc "$MODEL_PATH")|g" \
    -e "s|__MODEL_DIR__|$(esc "$MODEL_DIR")|g" \
    -e "s|__LOG_DIR__|$(esc "$LOG_DIR")|g" \
    -e "s|__BREW_PREFIX__|$(esc "$BREW_PREFIX")|g" \
    -e "s|__THREADS__|$(esc "$threads")|g" \
    -e "s|<!-- __EXTRA_ARGS__ -->|$(esc "$extra")|" \
    "$TEMPLATE" >"$tmp_plist"
if grep -q '__[A-Z_]*__' "$tmp_plist"; then rm -f "$tmp_plist"; die "unfilled placeholder in rendered plist"; fi
plutil -lint "$tmp_plist" >/dev/null || { rm -f "$tmp_plist"; die "rendered plist is invalid"; }
mv "$tmp_plist" "$PLIST"
chmod 644 "$PLIST"
echo "   installed (threads=$threads)"

uid=$(id -u)
domain="gui/$uid"
launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "user/$uid/$LABEL" >/dev/null 2>&1 || true
sleep 1
if ! launchctl bootstrap "$domain" "$PLIST" 2>/dev/null; then
  # No GUI session (nobody logged in at the server's screen): fall back to the
  # background user domain. With auto-login enabled the gui domain is used at boot.
  domain="user/$uid"
  echo "   no GUI login session; loading into $domain instead"
  launchctl bootstrap "$domain" "$PLIST"
fi
launchctl enable "$domain/$LABEL" || true
launchctl kickstart -k "$domain/$LABEL" >/dev/null 2>&1 || true
echo "   loaded in $domain"

# ---------------------------------------------------------------- 4. checks
step "Health check (http://127.0.0.1:$PORT/health)"
ok=0
for _ in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)
  if [ "$code" = 200 ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "   whisper-server did not become healthy (last HTTP code: ${code:-none}). Last log lines:"
  tail -n 30 "$LOG_DIR/whisper.err.log" 2>/dev/null || true
  exit 1
fi
echo "   healthy"

if grep -qi 'metal' "$LOG_DIR/whisper.err.log" 2>/dev/null; then
  echo "   GPU: $(grep -i -m1 -E 'using Metal|ggml_metal_init|MTL|Metal' "$LOG_DIR/whisper.err.log")"
else
  echo "   WARNING: no Metal lines in $LOG_DIR/whisper.err.log; it may be running on CPU only."
fi

listen=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u | tr '\n' ' ')
echo "   listening on: ${listen:-?}"
case "$listen" in
  *127.0.0.1:"$PORT"*) ;;
  *) echo "   WARNING: expected 127.0.0.1:$PORT only" ;;
esac

sample=$(find "$(brew --prefix whisper.cpp)/share" -name jfk.wav 2>/dev/null | head -n1 || true)
if [ -n "$sample" ]; then
  step "Sample transcription ($(basename "$sample"), 11 s of audio)"
  start=$(date +%s)
  out=$(curl -s -m 60 "http://127.0.0.1:$PORT/inference" -F "file=@$sample" -F response_format=json -F temperature=0.0 || true)
  end=$(date +%s)
  echo "   ${out:-<no response>}"
  echo "   took $((end - start)) s (spec target: about 2 s for a short clip; else use --model base.en)"
fi

step "Reachability from containers"
if command -v docker >/dev/null 2>&1 && [ -f "$ROOT/.env" ] \
   && [ -n "$("$ROOT/infra/scripts/compose.sh" ps -q web 2>/dev/null)" ]; then
  if "$ROOT/infra/scripts/compose.sh" exec -T web node -e '
    const u = (process.env.WHISPER_URL || "http://host.internal:8178") + "/health";
    fetch(u).then(async r => { console.log("   " + u + " ->", r.status, await r.text()); process.exit(r.ok ? 0 : 1); })
      .catch(e => { console.error("   " + u + " failed:", e.message); process.exit(1); })'; then
    echo "   OK: the web container reaches whisper on the host loopback."
  else
    echo "   FAILED: see docs/server-setup.md (whisper troubleshooting): try WHISPER_URL=http://host.docker.internal:8178"
  fi
else
  echo "   stack not running yet; after the first deploy, check with:"
  echo "   ~/homebase/infra/scripts/compose.sh exec -T web node -e 'fetch(process.env.WHISPER_URL+\"/health\").then(r=>r.text()).then(console.log)'"
fi
echo
echo "Done. Logs: $LOG_DIR/whisper.err.log   Restart: launchctl kickstart -k $domain/$LABEL"
