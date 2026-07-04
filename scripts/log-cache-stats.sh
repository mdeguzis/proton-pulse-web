#!/usr/bin/env bash
# Report cache state at a workflow boundary (#89).
#
# Called from the pipeline after the gh-pages restore + actions/cache
# restore steps so the log tells us exactly what state the pipeline was
# given before real work started: which caches exist, how old they are,
# and how many entries they carry. Makes it easy to tell whether the
# 7-day GOG/Epic catalog cache is doing its job vs re-fetching, and
# whether the release-years cache (#109) is actually accumulating.
#
# Args:
#   $1  label (e.g. "post-restore", "final") - printed in log lines
#
# Reads from the current working directory. Both actions/cache-restored
# .cache/ files and gh-pages-restored /tmp/protondb-output/ files are
# covered so one call at a boundary shows both layers.
set -euo pipefail

LABEL="${1:-cache-stats}"

# All cache files we care about, keyed by human-readable name. Each is
# looked up in a couple of candidate locations because the workflow
# copies them around between .cache/ and /tmp/protondb-output/.
declare -A CACHES=(
  ["actions/protondb-summary-probe-cache"]=".cache/protondb-summary-probe-cache.json"
  ["actions/steam-title-cache"]=".cache/steam-title-cache.json"
  ["actions/steam-content-descriptors-cache"]=".cache/steam-content-descriptors-cache.json"
  ["actions/gog-catalog-cache"]=".cache/gog-catalog-cache.json"
  ["actions/epic-catalog-cache"]=".cache/epic-catalog-cache.json"
  ["gh-pages/game-images-cache"]="/tmp/protondb-output/game-images-cache.json"
  ["gh-pages/release-years-cache"]="/tmp/protondb-output/release-years-cache.json"
)

echo "[cache-stats:$LABEL] --------------------------------"
for name in "${!CACHES[@]}"; do
  path="${CACHES[$name]}"
  if [ ! -f "$path" ]; then
    printf '[cache-stats:%s] %-42s MISSING (%s)\n' "$LABEL" "$name" "$path"
    continue
  fi
  # File age in whole days.
  age_secs=$(( $(date +%s) - $(stat -c %Y "$path") ))
  age_days=$(( age_secs / 86400 ))
  size_bytes=$(stat -c %s "$path")
  # Entry count when the file is a top-level JSON object; skip on parse
  # failure so the script never blows up on a partial write.
  entries=$(python3 -c "
import json, sys
try:
    d = json.load(open('$path'))
    print(len(d) if isinstance(d, (dict, list)) else '?')
except Exception:
    print('?')
" 2>/dev/null || echo "?")
  printf '[cache-stats:%s] %-42s %6s entries, %6d bytes, %2d days old\n' "$LABEL" "$name" "$entries" "$size_bytes" "$age_days"
done
echo "[cache-stats:$LABEL] --------------------------------"
