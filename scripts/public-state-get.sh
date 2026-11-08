#!/usr/bin/env bash
set -euo pipefail

# Read one file from R2 state over the public data host (#396). Keyless, so
# any job can read state without being handed the R2 write keys.
#
# Same exit codes as `r2-state.sh get`, so callers can tell "not there" from
# "could not read":
#   0  fetched to <dest>
#   3  not in the bucket (404)
#   1  anything else (network, 5xx, a .json that does not parse, a .gz that
#      does not test clean); <dest> is left alone
#
# Usage: public-state-get.sh <name> <dest>
# Env:   STATE_BASE  default https://data.proton-pulse.com/_state

name="${1:?name required}"
dest="${2:?dest required}"
BASE="${STATE_BASE:-https://data.proton-pulse.com/_state}"
log() { echo "[public-state-get] $*" >&2; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# curl prints 000 via -w on a transport failure and exits non-zero.
code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 120 "$BASE/$name" 2>/dev/null)" || true
code="${code:-000}"
if [ "$code" = 404 ]; then
  log "$BASE/$name: not in R2 state (404)"
  exit 3
fi
if [ "$code" != 200 ]; then
  log "$BASE/$name: read failed (HTTP $code)"
  exit 1
fi
case "$name" in
  *.json)
    if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; then
      log "$BASE/$name: not valid JSON ($(wc -c < "$tmp") bytes)"
      exit 1
    fi
    ;;
  *.gz)
    if ! gzip -t "$tmp" 2>/dev/null; then
      log "$BASE/$name: corrupt gzip ($(wc -c < "$tmp") bytes)"
      exit 1
    fi
    ;;
esac
mkdir -p "$(dirname "$dest")"
mv "$tmp" "$dest"
log "$BASE/$name: $(wc -c < "$dest") bytes to $dest"
