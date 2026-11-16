#!/usr/bin/env bash
set -euo pipefail

# Fetch files from R2 state over the public data host into <dest_dir> (#396).
# Read-only and keyless, so any job can use it: finalize uses it for the store
# catalog caches the weekly GOG / Epic workflows push to prod's `_state/`.
#
# A file that is missing (404) or unreadable is skipped with a WARNING. Callers
# treat a skipped file as "keep what you have" (the Actions cache copy), so
# this never fails the job; every outcome is logged with the HTTP status. The
# gh-pages fallback copy went with the branch (#396).
#
# Usage: fetch-public-state.sh <dest_dir> <file>...
# Env:   STATE_BASE  default https://data.proton-pulse.com/_state

DEST="${1:?dest dir required}"; shift
BASE="${STATE_BASE:-https://data.proton-pulse.com/_state}"
mkdir -p "$DEST"

for f in "$@"; do
  tmp="$(mktemp)"
  # curl prints 000 via -w on a transport failure AND exits non-zero, so an
  # `|| echo 000` fallback logged "HTTP 000000". Keep what -w printed.
  code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 60 "$BASE/$f" 2>/dev/null)" || true
  code="${code:-000}"
  if [ "$code" = 200 ] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; then
    mv "$tmp" "$DEST/$f"
    echo "[public-state] $f: $(wc -c < "$DEST/$f") bytes from $BASE"
    continue
  fi
  rm -f "$tmp"
  if [ "$code" = 200 ]; then
    why="not valid JSON"
  elif [ "$code" = 404 ]; then
    why="not in R2 state yet (404)"
  else
    why="HTTP $code"
  fi
  echo "[public-state] WARNING: $f: $why; skipped, keeping any cached copy"
done
