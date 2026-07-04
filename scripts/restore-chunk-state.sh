#!/usr/bin/env bash
# Restore probe-chunk state from gh-pages/.pipeline-state/ into the
# local pipeline cache. Phase 2 of #171: finalize now sources probe
# results from durable persistence instead of relying on the ephemeral
# actions cache alone. If any expected chunk is missing from the
# manifest, aborts with a clear error naming the chunk + last-updated
# timestamp so the operator knows exactly what to resume.
#
# Args:
#   $1  JSON array of expected chunk ids (e.g. '["01","02","03"]').
#       Passed from needs.build.outputs.expected_matrix (full plan).
#       Empty string / omitted = finalize_only mode: use whatever's in
#       the manifest as the expected set. #171 Phase 3.
#
# Behavior:
#   - manifest missing         -> WARN + exit 0 (first run after Phase 1
#                                 shipped, before any chunks persisted)
#   - empty expected + manifest -> use manifest's completed chunks as the
#                                 authoritative set (finalize_only path)
#   - manifest has all chunks  -> gunzip highest-numbered chunk snapshot
#                                 into .cache/protondb-summary-probe-cache.json
#   - manifest has a gap       -> EXIT 1 with clear "chunk NN missing" msg
set -euo pipefail

EXPECTED_CHUNKS_JSON="${1:-}"
STATE_ROOT="/tmp/pipeline-state-restore"
BRANCH="gh-pages"
CACHE_FILE=".cache/protondb-summary-probe-cache.json"

echo "[restore-chunk-state] expected chunks: $EXPECTED_CHUNKS_JSON"

rm -rf "$STATE_ROOT"
git clone --depth 1 --branch "$BRANCH" \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" \
  "$STATE_ROOT" 2>/dev/null || {
    echo "[restore-chunk-state] gh-pages clone failed -- likely first run, no state to restore"
    exit 0
}

MANIFEST_PATH="$STATE_ROOT/.pipeline-state/manifest.json"
if [ ! -f "$MANIFEST_PATH" ]; then
  echo "[restore-chunk-state] manifest.json not on gh-pages yet -- Phase 1 not run against this ref"
  exit 0
fi

# Verify every expected chunk is marked completed + has its snapshot.
# python handles the JSON parsing so we don't shell-parse; also emits
# the highest-numbered chunk id back so we know which snapshot to load.
# Empty EXPECTED_CHUNKS_JSON = finalize_only mode: use whatever's in
# the manifest's completed set as the expected list.
LATEST_CHUNK=$(python3 - "$MANIFEST_PATH" "$EXPECTED_CHUNKS_JSON" "$STATE_ROOT/.pipeline-state/chunks" <<'PY'
import json, sys, os
manifest_path, expected_json, chunks_dir = sys.argv[1:]
manifest = json.load(open(manifest_path))
chunks = manifest.get("chunks", {})

if not expected_json:
    # finalize_only: expected set IS whatever manifest says is completed.
    expected = sorted([c for c, e in chunks.items() if e.get("status") == "completed"])
    if not expected:
        print("[restore-chunk-state] finalize_only: manifest has no completed chunks", file=sys.stderr)
        sys.exit(1)
    print(f"[restore-chunk-state] finalize_only: manifest completed set = {expected}", file=sys.stderr)
else:
    expected = json.loads(expected_json)

missing = []
for cid in expected:
    entry = chunks.get(cid)
    snap = os.path.join(chunks_dir, f"chunk-{cid}.json.gz")
    if not entry or entry.get("status") != "completed":
        missing.append((cid, entry.get("completed_at") if entry else "never"))
    elif not os.path.exists(snap):
        missing.append((cid, f"manifest OK but snapshot missing (last completed {entry.get('completed_at')})"))

if missing:
    updated = manifest.get("updated_at", "unknown")
    print("MISSING", file=sys.stderr)
    print(f"[restore-chunk-state] manifest last updated: {updated}", file=sys.stderr)
    for cid, when in missing:
        print(f"[restore-chunk-state]   chunk {cid} missing since {when}", file=sys.stderr)
    sys.exit(1)

# Success: return the numerically highest chunk id -- its snapshot IS
# the canonical full-cache state (each chunk snapshots the whole cache
# after it ran, so the last one has everything).
latest = max(expected, key=lambda c: int(c))
print(latest)
PY
)

if [ -z "$LATEST_CHUNK" ]; then
  echo "[restore-chunk-state] no snapshot to load (verification failed above)"
  exit 1
fi

SNAP_PATH="$STATE_ROOT/.pipeline-state/chunks/chunk-${LATEST_CHUNK}.json.gz"
mkdir -p "$(dirname "$CACHE_FILE")"
gunzip -c "$SNAP_PATH" > "$CACHE_FILE"

APP_COUNT=$(python3 -c "import json; print(len(json.load(open('$CACHE_FILE'))))" 2>/dev/null || echo "?")
echo "[restore-chunk-state] restored from chunk $LATEST_CHUNK ($APP_COUNT apps)"
