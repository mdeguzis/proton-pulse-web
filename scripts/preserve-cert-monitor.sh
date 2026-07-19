#!/usr/bin/env bash
set -euo pipefail

# Preserve the cert monitor's files across the orphan-history gh-pages deploy (#359).
#
# The finalize deploy step in .github/workflows/update-data.yml recreates
# gh-pages as an orphan branch every pipeline run (git checkout --orphan +
# git rm -rf . + force-push). That wipes anything the standalone cert-monitor
# workflow committed between pipeline runs: cert-status.json and, critically,
# cert-history.json -- the append-only burndown series that cannot be
# regenerated. cert-status.json alone would be recreated within 6h by the next
# cert-monitor run, but the history would be lost for good.
#
# This helper reads the CURRENT gh-pages branch and copies both files into the
# fresh deploy directory. Called BEFORE `git add` in the deploy step so the
# orphan commit ships with them intact. Mirrors preserve-steam-type-cache.sh.
#
# Usage: preserve-cert-monitor.sh <deploy_dir> [remote_ref]
#   deploy_dir  -- the fresh orphan checkout directory to copy the files into.
#   remote_ref  -- git ref to read from (default: gh-pages).

DEPLOY_DIR="${1:?deploy_dir required}"
REMOTE_REF="${2:-gh-pages}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"
if ! git fetch --depth 1 origin "$REMOTE_REF" 2>/dev/null; then
  echo "[preserve-cert] could not fetch origin/$REMOTE_REF -- skipping"
  exit 0
fi

preserved=0
for f in cert-status.json cert-history.json; do
  if git show "origin/$REMOTE_REF:$f" > "$DEPLOY_DIR/$f" 2>/dev/null && [ -s "$DEPLOY_DIR/$f" ]; then
    echo "[preserve-cert] preserved $f from origin/$REMOTE_REF"
    preserved=$((preserved + 1))
  else
    # Nothing to preserve (first deploy, or the monitor has not run yet). Remove
    # the empty file the failed `git show` may have created so we do not commit
    # a zero-byte file.
    rm -f "$DEPLOY_DIR/$f"
  fi
done

echo "[preserve-cert] done ($preserved file(s) preserved)"
