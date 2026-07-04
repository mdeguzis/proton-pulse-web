#!/usr/bin/env bash
# Persist a probe chunk's cache + manifest entry to gh-pages/.pipeline-state/.
# Phase 1 of #171: durable state so a cancelled run doesn't throw away
# successful chunks. Runs after the probe step in each chunk job.
#
# Args:
#   $1  chunk id (e.g. "01", "02")
#   $2  GitHub run id (for provenance in the manifest)
#   $3  GitHub run attempt
#
# The push loop uses pull --rebase && push with up to 3 attempts + jittered
# backoff because scheduled runs and manual dispatches can overlap.
set -euo pipefail

CHUNK_ID="${1:?chunk id required}"
RUN_ID="${2:-}"
RUN_ATTEMPT="${3:-1}"

CACHE_FILE=".cache/protondb-summary-probe-cache.json"
STATE_ROOT="/tmp/pipeline-state"
BRANCH="gh-pages"

if [ ! -f "$CACHE_FILE" ]; then
  echo "[persist-chunk-state] $CACHE_FILE missing, nothing to persist"
  exit 0
fi

# App count = number of top-level keys in the probe cache. Used for the
# manifest entry so a human scanning the state can see how much data
# accumulated per chunk without opening the snapshot.
APP_COUNT=$(python3 -c "import json,sys; print(len(json.load(open('$CACHE_FILE'))))" 2>/dev/null || echo "0")

# Content hash of the cache file so idempotent-skip in Phase 4 has a
# deterministic key to compare against.
INPUT_SHA=$(sha256sum "$CACHE_FILE" | cut -d' ' -f1 | head -c 12)
COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "[persist-chunk-state] chunk=$CHUNK_ID app_count=$APP_COUNT input_sha=$INPUT_SHA"

# Clone the gh-pages branch shallow. Isolated dir so it doesn't clash
# with any existing worktree in the runner. Use the workflow's default
# GITHUB_TOKEN via the origin remote's HTTPS auth (already configured
# by actions/checkout in earlier steps).
rm -rf "$STATE_ROOT"
git clone --depth 1 --branch "$BRANCH" "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$STATE_ROOT"
cd "$STATE_ROOT"
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"

mkdir -p .pipeline-state/chunks

# Snapshot the probe cache as this chunk's compressed slice. Full cache
# per chunk (not a delta) so recovery only needs to grab the latest
# chunk's file, no ordering assumptions.
gzip -c "${GITHUB_WORKSPACE:-/home/runner/work/proton-pulse-web/proton-pulse-web}/$CACHE_FILE" > ".pipeline-state/chunks/chunk-${CHUNK_ID}.json.gz"

# Rebuild the manifest entry for this chunk. Uses python for JSON
# safety (jq isn't guaranteed on runners).
MANIFEST_PATH=".pipeline-state/manifest.json"
python3 - "$MANIFEST_PATH" "$CHUNK_ID" "$APP_COUNT" "$INPUT_SHA" "$COMPLETED_AT" "$RUN_ID" "$RUN_ATTEMPT" <<'PY'
import json, os, sys
manifest_path, chunk_id, app_count, input_sha, completed_at, run_id, run_attempt = sys.argv[1:]
data = {"chunks": {}}
if os.path.exists(manifest_path):
    try:
        data = json.load(open(manifest_path))
        if "chunks" not in data or not isinstance(data["chunks"], dict):
            data = {"chunks": {}}
    except Exception:
        data = {"chunks": {}}
data["chunks"][chunk_id] = {
    "status": "completed",
    "app_count": int(app_count),
    "input_sha": input_sha,
    "completed_at": completed_at,
    "run_id": run_id,
    "run_attempt": int(run_attempt),
}
data["updated_at"] = completed_at
with open(manifest_path, "w") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY

git add .pipeline-state
if git diff --cached --quiet; then
  echo "[persist-chunk-state] no changes to commit"
  exit 0
fi
git commit -m "pipeline-state: chunk $CHUNK_ID @ run $RUN_ID (#171)"

# Push with retry: overlapping runs can race on the same branch. Rebase
# on top of concurrent state pushes and retry with jittered backoff.
for attempt in 1 2 3; do
  if git push origin "HEAD:$BRANCH"; then
    echo "[persist-chunk-state] pushed on attempt $attempt"
    exit 0
  fi
  echo "[persist-chunk-state] push attempt $attempt failed, rebasing"
  git fetch origin "$BRANCH"
  git rebase "origin/$BRANCH" || {
    echo "[persist-chunk-state] rebase failed, aborting"
    git rebase --abort || true
    exit 1
  }
  sleep $((RANDOM % 5 + 2))
done

echo "[persist-chunk-state] push failed after 3 attempts"
exit 1
