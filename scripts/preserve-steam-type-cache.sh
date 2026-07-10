#!/usr/bin/env bash
set -euo pipefail

# Preserve steam-type-cache.json across the orphan-history gh-pages deploy (#263).
#
# The finalize deploy step in .github/workflows/update-data.yml recreates
# gh-pages as an orphan branch every run. That wipes anything the standalone
# enrich-steam-types workflow committed between pipeline runs -- specifically
# steam-type-cache.json plus the column 11 (Steam type) entries in
# search-index.json.
#
# This helper reads the CURRENT gh-pages branch (which still has the enricher
# state), pulls steam-type-cache.json out, and re-applies each cached type to
# the fresh search-index.json in the deploy directory. Called BEFORE `git add`
# in the deploy step so the orphan commit ships with the preserved cache.
#
# Usage: preserve-steam-type-cache.sh <deploy_dir> [remote_ref]
#   deploy_dir  -- the current directory of the fresh orphan checkout, must
#                  already contain search-index.json (the pipeline's output).
#   remote_ref  -- optional git ref to read the cache from (default: gh-pages).

DEPLOY_DIR="${1:?deploy_dir required}"
REMOTE_REF="${2:-gh-pages}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$DEPLOY_DIR/search-index.json" ]; then
  echo "[preserve-cache] $DEPLOY_DIR/search-index.json missing -- nothing to enrich, skipping"
  exit 0
fi

# Fetch the previous gh-pages state into a shallow scratch checkout so we can
# pluck steam-type-cache.json out of it. If the ref doesn't exist yet (first
# ever deploy) just skip -- there's nothing to preserve.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$REPO_ROOT"
if ! git fetch --depth 1 origin "$REMOTE_REF" 2>/dev/null; then
  echo "[preserve-cache] could not fetch origin/$REMOTE_REF -- skipping"
  exit 0
fi

if ! git show "origin/$REMOTE_REF:steam-type-cache.json" > "$SCRATCH/steam-type-cache.json" 2>/dev/null; then
  echo "[preserve-cache] origin/$REMOTE_REF has no steam-type-cache.json -- skipping"
  exit 0
fi

if [ ! -s "$SCRATCH/steam-type-cache.json" ]; then
  echo "[preserve-cache] cache from origin/$REMOTE_REF is empty -- skipping"
  exit 0
fi

echo "[preserve-cache] found existing steam-type-cache.json on origin/$REMOTE_REF"

# Copy the cache into the deploy dir + apply its types to search-index column 11.
cp "$SCRATCH/steam-type-cache.json" "$DEPLOY_DIR/steam-type-cache.json"

python3 - "$DEPLOY_DIR" <<'PY'
import json, sys
from collections import Counter
deploy = sys.argv[1]
with open(f"{deploy}/steam-type-cache.json") as f:
    cache = json.load(f)
with open(f"{deploy}/search-index.json") as f:
    rows = json.load(f)
updated = 0
for row in rows:
    if not isinstance(row, list) or len(row) < 1:
        continue
    aid = str(row[0])
    if not aid.isdigit():
        continue
    t = cache.get(aid)
    if not t:
        continue
    while len(row) < 12:
        row.append(None)
    row[11] = t
    updated += 1
with open(f"{deploy}/search-index.json", "w") as f:
    f.write(json.dumps(rows, separators=(",", ":")))
c = Counter()
for r in rows:
    c[r[11] if len(r) > 11 else None] += 1
print(f"[preserve-cache] applied {updated} cached types to search-index.json")
for t, n in c.most_common(10):
    if t is not None:
        print(f"  {t!r}: {n}")
PY

echo "[preserve-cache] done"
