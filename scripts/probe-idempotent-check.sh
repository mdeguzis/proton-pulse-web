#!/usr/bin/env bash
# Phase 4 of #171: idempotent chunk skip.
#
# Before a chunk runs its probe, compare a fingerprint of the current
# .cache/protondb-summary-probe-cache.json against the input_sha the
# same chunk stored in gh-pages/.pipeline-state/manifest.json on the
# LAST successful run. If they match, the cache hasn't drifted since --
# running probe again would find nothing new to fetch. Emits
# `skip=true` on $GITHUB_OUTPUT so the probe step can gate itself.
#
# Args:
#   $1  chunk id (e.g. "01")
#
# Env:
#   GITHUB_OUTPUT          required by Actions
#   GITHUB_TOKEN           required to fetch gh-pages manifest
#   GITHUB_REPOSITORY      required for the clone URL
#
# Outputs:
#   skip=true|false
set -euo pipefail

CHUNK_ID="${1:?chunk id required}"
CACHE_FILE=".cache/protondb-summary-probe-cache.json"

if [ ! -f "$CACHE_FILE" ]; then
  echo "[probe-idempotent-check] no cache file yet, cannot skip -- probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

CURRENT_SHA=$(sha256sum "$CACHE_FILE" | cut -d' ' -f1 | head -c 12)

STATE_ROOT="/tmp/pipeline-state-idem"
rm -rf "$STATE_ROOT"
if ! git clone --depth 1 --branch gh-pages \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" \
  "$STATE_ROOT" 2>/dev/null; then
  echo "[probe-idempotent-check] gh-pages clone failed -- probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

MANIFEST_PATH="$STATE_ROOT/.pipeline-state/manifest.json"
if [ ! -f "$MANIFEST_PATH" ]; then
  echo "[probe-idempotent-check] no manifest yet -- probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Look up this chunk's stored input_sha. If the cache hasn't changed
# since it last ran (same sha), skip -- probe would be a no-op.
STORED_SHA=$(python3 - "$MANIFEST_PATH" "$CHUNK_ID" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
entry = manifest.get("chunks", {}).get(sys.argv[2])
if entry and entry.get("status") == "completed":
    print(entry.get("input_sha", ""), end="")
PY
)

if [ -n "$STORED_SHA" ] && [ "$STORED_SHA" = "$CURRENT_SHA" ]; then
  echo "[probe-idempotent-check] chunk $CHUNK_ID: state unchanged (sha=$CURRENT_SHA), SKIPPING probe"
  echo "skip=true" >> "$GITHUB_OUTPUT"
else
  echo "[probe-idempotent-check] chunk $CHUNK_ID: state drift (current=$CURRENT_SHA stored=${STORED_SHA:-none}) -- probe will run"
  echo "skip=false" >> "$GITHUB_OUTPUT"
fi
