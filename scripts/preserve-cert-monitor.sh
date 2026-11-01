#!/usr/bin/env bash
set -euo pipefail

# Copy the cert monitor's files into a Pages deploy directory (#359, #396).
#
# cert-monitor.yml writes cert-status.json + cert-history.json to R2 state
# (`_state/` in the prod data bucket) every 6h. The status page reads them
# same-origin, so every shell deploy has to carry the latest copies. They used
# to be read from origin/gh-pages; that branch is being archived (#396).
#
# Read over the public data host, so the shell deploy needs no R2 keys. The
# objects are uploaded with Cache-Control: no-store, so this is never a stale
# edge copy. The cert checked is prod's, so staging deploys show prod's cert
# too, same as before.
#
# Best-effort by design: a missing file leaves the status page on its "not run
# yet" empty state, which is better than failing a shell deploy. Every outcome
# is logged with the HTTP status so a broken read is visible in the run.
#
# Usage: preserve-cert-monitor.sh <deploy_dir>
# Env:   CERT_STATE_BASE  default https://data.proton-pulse.com/_state

DEPLOY_DIR="${1:?deploy_dir required}"
BASE="${CERT_STATE_BASE:-https://data.proton-pulse.com/_state}"

preserved=0
for f in cert-status.json cert-history.json; do
  tmp="$(mktemp)"
  code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 20 "$BASE/$f" 2>/dev/null || echo 000)"
  if [ "$code" = 200 ] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; then
    mv "$tmp" "$DEPLOY_DIR/$f"
    echo "[preserve-cert] preserved $f from $BASE"
    preserved=$((preserved + 1))
  else
    rm -f "$tmp"
    if [ "$code" = 200 ]; then
      echo "[preserve-cert] WARNING: $BASE/$f is not valid JSON; not shipped"
    elif [ "$code" = 404 ]; then
      echo "[preserve-cert] $f not in R2 state yet (404); status page shows its empty state"
    else
      echo "[preserve-cert] WARNING: could not read $BASE/$f (HTTP $code); not shipped"
    fi
  fi
done
echo "[preserve-cert] done ($preserved file(s) preserved)"
