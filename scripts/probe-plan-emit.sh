#!/usr/bin/env bash
# Emit chunk_matrix + expected_matrix from the probe-plan JSON to GITHUB_OUTPUT,
# and start this run's chunk-state manifest in R2 state (#171, #396).
#
# Args:
#   $1  path to probe-plan JSON (output of `probe-plan` CLI subcommand)
#
# Env:
#   RESUME_MODE       "true" to subtract chunks the current manifest already
#                     has as completed, so probe-chunks only runs the missing
#                     ones. Any other value = full plan (normal path).
#   RUN_ID            this run's id, recorded as the manifest's plan_run_id
#   STATE_BASE        public read base for this env's state (resume only)
#   R2_BUCKET + CLOUDFLARE_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY
#                     needed in normal mode to write the fresh manifest
#   GITHUB_OUTPUT     required by Actions; we append the outputs here.
#
# A normal run replaces the manifest with an empty one for its own plan.
# Entries used to accumulate forever, so every chunk read as "completed" from
# some earlier night: a resume subtracted all of them and ran nothing, and
# finalize's missing-chunk check could never fire. Resume keeps the manifest
# the interrupted run left behind.
#
# Outputs (written to $GITHUB_OUTPUT):
#   chunk_count      integer -- how many chunks probe-chunks will run this dispatch
#   chunk_matrix     JSON array -- the chunk ids to run this dispatch
#   expected_matrix  JSON array -- the FULL plan (this-run + already-completed).
#                    Finalize uses this to verify no chunks are missing after
#                    the dispatch, not just the ones this run touched.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLAN_JSON="${1:?plan JSON path required}"
RESUME_MODE="${RESUME_MODE:-false}"
MANIFEST="pipeline-state/manifest.json"
log() { echo "[probe-plan-emit] $*"; }

FULL_PLAN=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))['chunks']))" "$PLAN_JSON")
UNCACHED=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['uncached_count'])" "$PLAN_JSON")
count() { python3 -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$1"; }

if [ "$RESUME_MODE" != "true" ]; then
  RUN_MATRIX="$FULL_PLAN"
  log "normal mode: running full plan ($(count "$FULL_PLAN") chunks, $UNCACHED uncached)"
  if [ "$(count "$FULL_PLAN")" -gt 0 ]; then
    # An empty plan leaves the last manifest alone, so finalize_only still
    # has the previous run's chunks to restore.
    fresh="$(mktemp)"
    python3 - "$fresh" "${RUN_ID:-}" "$FULL_PLAN" <<'PY'
import json, sys, time
path, run_id, plan = sys.argv[1:]
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
json.dump({"plan_run_id": run_id, "planned": json.loads(plan), "chunks": {},
           "updated_at": now}, open(path, "w"), indent=2, sort_keys=True)
PY
    bash "$HERE/r2-state.sh" put "$fresh" "$MANIFEST"
    rm -f "$fresh"
    log "started a fresh manifest for run ${RUN_ID:-?} in ${R2_BUCKET:-?}"
  fi
else
  # Resume: subtract chunks the interrupted run completed. Motivating rescue
  # path: chunk 8 stalled while 1-7 + 9-10 completed, so the new dispatch
  # runs just [08].
  tmp="$(mktemp)"
  set +e
  bash "$HERE/public-state-get.sh" "$MANIFEST" "$tmp"
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    RUN_MATRIX=$(python3 - "$FULL_PLAN" "$tmp" <<'PY'
import json, sys
full = json.loads(sys.argv[1])
manifest = json.load(open(sys.argv[2]))
completed = {c for c, e in manifest.get("chunks", {}).items() if e.get("status") == "completed"}
print(json.dumps([c for c in full if c not in completed]))
PY
)
    log "resume mode: plan has $(count "$FULL_PLAN") chunks, running $(count "$RUN_MATRIX") missing (manifest from run $(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('plan_run_id') or '?')" "$tmp"))"
  elif [ "$rc" = 3 ]; then
    RUN_MATRIX="$FULL_PLAN"
    log "resume mode requested but there is no manifest in R2 state; running the full plan"
  else
    RUN_MATRIX="$FULL_PLAN"
    log "WARNING: resume mode could not read the manifest (rc=$rc); running the full plan"
  fi
  rm -f "$tmp"
fi

RUN_COUNT=$(count "$RUN_MATRIX")

{
  echo "chunk_count=$RUN_COUNT"
  echo "chunk_matrix=$RUN_MATRIX"
  echo "expected_matrix=$FULL_PLAN"
} >> "$GITHUB_OUTPUT"

log "chunk_count=$RUN_COUNT chunk_matrix=$RUN_MATRIX"
log "expected_matrix=$FULL_PLAN"
