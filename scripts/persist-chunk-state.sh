#!/usr/bin/env bash
# Persist a probe chunk's cache + manifest entry to R2 state (#171, #396).
# Durable state so a cancelled run doesn't throw away successful chunks. Runs
# after a successful probe step in each chunk job.
#
#   _state/pipeline-state/manifest.json          one entry per chunk of this plan
#   _state/pipeline-state/chunks/chunk-NN.json.gz the full probe cache after NN
#
# This used to be a commit to gh-pages/.pipeline-state/, which was shared by
# prod and staging runs. Each env's bucket now holds its own.
#
# Args:
#   $1  chunk id (e.g. "01", "02")
#   $2  GitHub run id (for provenance in the manifest)
#   $3  GitHub run attempt
#
# Env: R2_BUCKET, CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#
# The manifest is read, updated and written back. Chunks inside a run go one
# at a time (max-parallel: 1). Two overlapping runs in the same env can still
# lose an entry; finalize then names the missing chunk and stops, so the race
# is loud rather than silent.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/r2-state.sh"
CHUNK_ID="${1:?chunk id required}"
RUN_ID="${2:-}"
RUN_ATTEMPT="${3:-1}"
CACHE_FILE=".cache/protondb-summary-probe-cache.json"
MANIFEST="pipeline-state/manifest.json"
log() { echo "[persist-chunk-state] $*"; }

if ! [[ "$CHUNK_ID" =~ ^[0-9]+$ ]]; then
  log "refusing chunk id '$CHUNK_ID'"
  exit 1
fi
if [ ! -f "$CACHE_FILE" ]; then
  log "$CACHE_FILE missing, nothing to persist"
  exit 0
fi

# The cache is {"fetched_at": ..., "apps": {...}}; count the apps, not the
# two top-level keys (the old count read 2 for every chunk).
APP_COUNT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('apps', d)) if isinstance(d, dict) else 0)" "$CACHE_FILE")
# Content hash of the cache file, the key the idempotent check compares.
INPUT_SHA=$(sha256sum "$CACHE_FILE" | cut -d' ' -f1 | head -c 12)
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "chunk=$CHUNK_ID app_count=$APP_COUNT input_sha=$INPUT_SHA bucket=${R2_BUCKET:-?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Snapshot first, manifest second: a manifest entry must never point at a
# snapshot that was not uploaded. Full cache per chunk (not a delta), so a
# restore only needs the latest chunk's file.
gzip -c "$CACHE_FILE" > "$work/chunk.json.gz"
bash "$STATE" put "$work/chunk.json.gz" "pipeline-state/chunks/chunk-${CHUNK_ID}.json.gz"

set +e
bash "$STATE" get "$MANIFEST" "$work/manifest.json"
rc=$?
set -e
case "$rc" in
  0) ;;
  3) log "no manifest in ${R2_BUCKET:-?} yet; starting one" ;;
  *) log "ERROR: could not read the manifest (rc=$rc); not overwriting it"; exit 1 ;;
esac

python3 - "$work/manifest.json" "$CHUNK_ID" "$APP_COUNT" "$INPUT_SHA" "$COMPLETED_AT" "$RUN_ID" "$RUN_ATTEMPT" <<'PY'
import json, os, sys
path, chunk_id, app_count, input_sha, completed_at, run_id, run_attempt = sys.argv[1:]
data = json.load(open(path)) if os.path.exists(path) else {}
if not isinstance(data.get("chunks"), dict):
    data["chunks"] = {}
data["chunks"][chunk_id] = {
    "status": "completed",
    "app_count": int(app_count),
    "input_sha": input_sha,
    "completed_at": completed_at,
    "run_id": run_id,
    "run_attempt": int(run_attempt),
}
data["updated_at"] = completed_at
with open(path, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
bash "$STATE" put "$work/manifest.json" "$MANIFEST"
log "chunk $CHUNK_ID recorded"
