#!/usr/bin/env bash
# Emit chunk_matrix + expected_matrix from the probe-plan JSON to GITHUB_OUTPUT.
#
# Args:
#   $1  path to probe-plan JSON (output of `probe-plan` CLI subcommand)
#
# Env:
#   RESUME_MODE       "true" to subtract already-completed chunks from
#                     the plan so probe-chunks only runs the missing ones.
#                     Any other value = full plan (normal path).
#   GITHUB_OUTPUT     required by Actions; we append the two outputs here.
#   GITHUB_TOKEN      required only when RESUME_MODE=true (to fetch manifest).
#   GITHUB_REPOSITORY required only when RESUME_MODE=true.
#
# Outputs (written to $GITHUB_OUTPUT):
#   chunk_count      integer -- how many chunks probe-chunks will run this dispatch
#   chunk_matrix     JSON array -- the chunk ids to run this dispatch
#   expected_matrix  JSON array -- the FULL plan (this-run + already-completed).
#                    Finalize uses this to verify no chunks are missing after
#                    the dispatch, not just the ones this run touched.
set -euo pipefail

PLAN_JSON="${1:?plan JSON path required}"
RESUME_MODE="${RESUME_MODE:-false}"

FULL_PLAN=$(python3 -c "import json; d=json.load(open('$PLAN_JSON')); print(json.dumps(d['chunks']))")
UNCACHED=$(python3 -c "import json; print(json.load(open('$PLAN_JSON'))['uncached_count'])")

if [ "$RESUME_MODE" != "true" ]; then
  RUN_MATRIX="$FULL_PLAN"
  echo "[probe-plan-emit] normal mode: running full plan ($UNCACHED uncached)"
else
  # Resume: pull gh-pages manifest, subtract chunks marked completed so
  # probe-chunks only re-runs the missing ones. Motivating rescue path:
  # chunk 8 stalled while 1-7 + 9-10 completed -> new dispatch runs just [08].
  STATE_ROOT="/tmp/pipeline-state-plan"
  rm -rf "$STATE_ROOT"
  if git clone --depth 1 --branch gh-pages \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" \
    "$STATE_ROOT" 2>/dev/null && [ -f "$STATE_ROOT/.pipeline-state/manifest.json" ]; then
    RUN_MATRIX=$(python3 - "$FULL_PLAN" "$STATE_ROOT/.pipeline-state/manifest.json" <<'PY'
import json, sys
full = json.loads(sys.argv[1])
manifest = json.load(open(sys.argv[2]))
completed = {c for c, e in manifest.get("chunks", {}).items() if e.get("status") == "completed"}
remaining = [c for c in full if c not in completed]
print(json.dumps(remaining))
PY
)
    RUN_COUNT=$(python3 -c "import json; print(len(json.loads('$RUN_MATRIX')))")
    echo "[probe-plan-emit] resume mode: full plan has ${#FULL_PLAN} chunks, running $RUN_COUNT missing"
  else
    RUN_MATRIX="$FULL_PLAN"
    echo "[probe-plan-emit] resume mode requested but manifest missing -- running full plan"
  fi
fi

RUN_COUNT=$(python3 -c "import json; print(len(json.loads('$RUN_MATRIX')))")

{
  echo "chunk_count=$RUN_COUNT"
  echo "chunk_matrix=$RUN_MATRIX"
  echo "expected_matrix=$FULL_PLAN"
} >> "$GITHUB_OUTPUT"

echo "[probe-plan-emit] chunk_count=$RUN_COUNT chunk_matrix=$RUN_MATRIX"
echo "[probe-plan-emit] expected_matrix=$FULL_PLAN"
