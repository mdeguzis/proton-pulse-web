#!/usr/bin/env bash
# Phase 4 of #171: idempotent chunk skip.
#
# Before a chunk runs its probe, compare a fingerprint of the current
# .cache/protondb-summary-probe-cache.json against the input_sha the same
# chunk stored in R2 state (_state/pipeline-state/manifest.json, #396) when
# it last completed in this plan. If they match, the cache hasn't drifted, so
# running the probe again would find nothing new to fetch. Emits `skip=true`
# on $GITHUB_OUTPUT so the probe step can gate itself.
#
# Any doubt (no cache, no manifest, unreadable manifest) means the probe
# runs. Running it is always safe; skipping wrongly is not.
#
# Args:
#   $1  chunk id (e.g. "01")
#
# Env:
#   GITHUB_OUTPUT  required by Actions
#   STATE_BASE     public read base for this env's state
#
# Outputs:
#   skip=true|false
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHUNK_ID="${1:?chunk id required}"
CACHE_FILE=".cache/protondb-summary-probe-cache.json"
log() { echo "[probe-idempotent-check] $*"; }

if [ ! -f "$CACHE_FILE" ]; then
  log "no cache file yet, cannot skip; probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

CURRENT_SHA=$(sha256sum "$CACHE_FILE" | cut -d' ' -f1 | head -c 12)

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT
set +e
bash "$HERE/public-state-get.sh" pipeline-state/manifest.json "$manifest"
rc=$?
set -e
if [ "$rc" != 0 ]; then
  log "no readable manifest (rc=$rc); probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

STORED_SHA=$(python3 - "$manifest" "$CHUNK_ID" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1])).get("chunks", {}).get(sys.argv[2])
if entry and entry.get("status") == "completed":
    print(entry.get("input_sha", ""), end="")
PY
)

if [ -n "$STORED_SHA" ] && [ "$STORED_SHA" = "$CURRENT_SHA" ]; then
  log "chunk $CHUNK_ID: state unchanged (sha=$CURRENT_SHA), SKIPPING probe"
  echo "skip=true" >> "$GITHUB_OUTPUT"
else
  log "chunk $CHUNK_ID: state drift (current=$CURRENT_SHA stored=${STORED_SHA:-none}); probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
fi
