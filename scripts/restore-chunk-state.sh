#!/usr/bin/env bash
# Restore probe-chunk state from R2 state (_state/pipeline-state/, #396) into
# the local pipeline cache. Phase 2 of #171: finalize sources probe results
# from durable state instead of relying on the ephemeral Actions cache alone.
# If any expected chunk is missing from the manifest, aborts with a clear
# error naming the chunk so the operator knows exactly what to resume.
#
# Args:
#   $1  JSON array of expected chunk ids (e.g. '["01","02","03"]').
#       Passed from needs.build.outputs.expected_matrix (full plan).
#       Empty string / omitted = finalize_only mode: use whatever's in
#       the manifest as the expected set. #171 Phase 3.
#
# Env:
#   STATE_BASE  public read base. Staging finalize-only runs point it at
#               prod's state on purpose; staging pipeline runs at their own.
#
# Behavior:
#   - manifest unreadable        -> EXIT 1
#   - no manifest, finalize_only -> WARN + exit 0 (keep the Actions cache copy)
#   - no manifest, chunks ran    -> EXIT 1 (persist should have written one)
#   - empty expected + manifest  -> use manifest's completed chunks as the
#                                   authoritative set (finalize_only path)
#   - manifest has all chunks    -> gunzip highest-numbered chunk snapshot
#                                   into .cache/protondb-summary-probe-cache.json
#   - manifest has a gap         -> EXIT 1 with clear "chunk NN missing" msg
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_CHUNKS_JSON="${1:-}"
CACHE_FILE=".cache/protondb-summary-probe-cache.json"
log() { echo "[restore-chunk-state] $*"; }

log "expected chunks: ${EXPECTED_CHUNKS_JSON:-<finalize_only: the manifest completed set>} from ${STATE_BASE:-https://data.proton-pulse.com/_state}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

set +e
bash "$HERE/public-state-get.sh" pipeline-state/manifest.json "$work/manifest.json"
rc=$?
set -e
if [ "$rc" = 3 ]; then
  if [ -z "$EXPECTED_CHUNKS_JSON" ]; then
    log "WARNING: no chunk-state manifest in R2 state; finalizing on the Actions cache copy"
    exit 0
  fi
  log "ERROR: this run probed chunks but R2 state has no manifest; persist-chunk-state did not record them"
  exit 1
elif [ "$rc" != 0 ]; then
  log "ERROR: could not read the chunk-state manifest (rc=$rc)"
  exit 1
fi

# Verify every expected chunk is marked completed. python handles the JSON
# and prints the highest-numbered chunk id, whose snapshot is the full cache.
LATEST_CHUNK=$(python3 - "$work/manifest.json" "$EXPECTED_CHUNKS_JSON" <<'PY'
import json, sys
manifest_path, expected_json = sys.argv[1:]
manifest = json.load(open(manifest_path))
chunks = manifest.get("chunks", {})
where = f"plan run {manifest.get('plan_run_id') or '?'}"

if not expected_json:
    expected = sorted(c for c, e in chunks.items() if e.get("status") == "completed")
    if not expected:
        print(f"[restore-chunk-state] finalize_only: manifest ({where}) has no completed chunks", file=sys.stderr)
        sys.exit(1)
    print(f"[restore-chunk-state] finalize_only: manifest ({where}) completed set = {expected}", file=sys.stderr)
else:
    expected = json.loads(expected_json)

missing = [c for c in expected if (chunks.get(c) or {}).get("status") != "completed"]
if missing:
    print(f"[restore-chunk-state] manifest ({where}) last updated: {manifest.get('updated_at', 'unknown')}", file=sys.stderr)
    for cid in missing:
        print(f"[restore-chunk-state]   chunk {cid} missing; run `make gh-resume`", file=sys.stderr)
    sys.exit(1)

print(max(expected, key=int))
PY
)

if [ -z "$LATEST_CHUNK" ]; then
  log "no snapshot to load (verification failed above)"
  exit 1
fi

set +e
bash "$HERE/public-state-get.sh" "pipeline-state/chunks/chunk-${LATEST_CHUNK}.json.gz" "$work/chunk.json.gz"
rc=$?
set -e
if [ "$rc" != 0 ]; then
  log "ERROR: manifest says chunk $LATEST_CHUNK completed but its snapshot could not be read (rc=$rc)"
  exit 1
fi

mkdir -p "$(dirname "$CACHE_FILE")"
gunzip -c "$work/chunk.json.gz" > "$CACHE_FILE"
APP_COUNT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('apps', d)))" "$CACHE_FILE")
log "restored from chunk $LATEST_CHUNK ($APP_COUNT apps)"
