#!/usr/bin/env bash
# Smoke test the webui locally.
#
# Copies the site into a temp dir, injects a tiny error-catching <script> at
# the top of every HTML file's <head>, serves that copy on a local port, and
# runs scripts/smoke-test.py against it. The error catcher must run before
# bundle scripts so we see top-level ReferenceErrors that would silently
# break the render path (like the renderFormResponses bug).
#
# Requires selenium + Firefox/geckodriver on PATH (`python3 -m pip install
# --user selenium`). Runs against the system python3 rather than `uv run
# --with selenium` -- on Termux, uv can't resolve a matching interpreter
# (see ~/.claude/rules/project-learnings.md platform-general notes) and
# just hangs/fails before ever reaching the browser.
#
# Usage:
#   scripts/smoke.sh                      # defaults
#   PORT=8001 scripts/smoke.sh            # different port
#   BASE_URL=https://www.proton-pulse.com scripts/smoke.sh   # test live site

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8765}"
WAIT="${WAIT:-10}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${SMOKE_DIR:-}" && -d "$SMOKE_DIR" ]]; then
    rm -rf "$SMOKE_DIR"
  fi
  if [[ -n "${HTTP_LOG:-}" && -f "$HTTP_LOG" ]]; then
    rm -f "$HTTP_LOG"
  fi
}
trap cleanup EXIT

if [[ -n "${BASE_URL:-}" ]]; then
  # Live test: skip server, run python script directly. Error injection
  # won't happen against the live site -- we still get DOM-state assertions
  echo "Live smoke against $BASE_URL"
  python3 "$ROOT/scripts/smoke-test.py" \
    --base-url "$BASE_URL" --wait "$WAIT"
  exit $?
fi

# Local: copy site, inject error catcher, serve, test, cleanup
SMOKE_DIR="$(mktemp -d -t pp-smoke-XXXXXX)"
echo "Staging copy at $SMOKE_DIR"
cp -r "$ROOT"/* "$SMOKE_DIR/"

# Inject error catcher into every HTML file's <head>. Snippet captures both
# window.error and unhandledrejection into window.__smoke_errors so the
# python harness can read them with execute_script.
INJECT='<script>(function(){window.__smoke_errors=[];window.addEventListener("error",function(e){window.__smoke_errors.push((e.message||String(e.error))+" @ "+(e.filename||"?")+":"+(e.lineno||"?"));});window.addEventListener("unhandledrejection",function(e){window.__smoke_errors.push("unhandledrejection: "+((e.reason&&(e.reason.stack||e.reason.message))||String(e.reason)));});})();</script>'

for f in "$SMOKE_DIR"/*.html; do
  [[ -f "$f" ]] || continue
  # Insert right after <head ...> -- matches both `<head>` and `<head foo="bar">`
  python3 -c "
import re, sys
p = sys.argv[1]
s = open(p).read()
# Skip if already injected (safety against double-runs)
if '__smoke_errors' in s:
    sys.exit(0)
new = re.sub(r'(<head[^>]*>)', r'\1' + sys.argv[2], s, count=1)
open(p, 'w').write(new)
" "$f" "$INJECT"
done

echo "Starting http.server on :$PORT"
# mktemp (not a hardcoded /tmp path) so this respects $TMPDIR on Termux,
# which has no writable /tmp. Cleaned up by the trap above.
HTTP_LOG="$(mktemp -t pp-smoke-http-XXXXXX.log)"
python3 -m http.server "$PORT" --directory "$SMOKE_DIR" >"$HTTP_LOG" 2>&1 &
SERVER_PID=$!
sleep 1

# Wait until the server is actually responding before driving Firefox
for _ in {1..10}; do
  if curl -sf "http://127.0.0.1:$PORT/app.html" >/dev/null; then
    break
  fi
  sleep 0.5
done

python3 "$ROOT/scripts/smoke-test.py" \
  --base-url "http://127.0.0.1:$PORT" --wait "$WAIT"
