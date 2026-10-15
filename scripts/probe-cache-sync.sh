#!/usr/bin/env bash
# Carry the finalize probe caches across runs through the Actions cache (#258).
#
# These caches used to round-trip through the gh-pages branch: seeded from it
# at the start of finalize, written back by the orphan deploy at the end. The
# Cloudflare deploy (#362) skips that write-back, so since 2026-08-23 every run
# has started from the same frozen snapshot, found every entry past its TTL,
# spent its whole probe cap re-checking them, and thrown the results away.
#
#   restore  overlay <cache_dir>/probe-caches/*.json onto <output_dir>, so the
#            last run's results win over the gh-pages seed already there
#   save     copy <output_dir>'s caches into <cache_dir>/probe-caches/ before
#            the Actions cache is saved
#
# A file that is missing or not valid JSON is never copied in either
# direction: restore keeps whatever seed is already in place, save keeps the
# previous run's copy. Each file logs where it came from.
#
# Usage: bash scripts/probe-cache-sync.sh restore|save <cache_dir> <output_dir>

set -euo pipefail

MODE=${1:?usage: probe-cache-sync.sh restore|save <cache_dir> <output_dir>}
CACHE_DIR=${2:?missing cache_dir}
OUTPUT_DIR=${3:?missing output_dir}
STORE="$CACHE_DIR/probe-caches"

FILES=(
  game-images-cache.json
  game-images-skip.json
  nonsteam-images-cache.json
  release-years-cache.json
  app-id-validation-cache.json
  steam-type-cache.json
)

is_json() {
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
}

copy_if_json() {
  local src=$1 dst=$2 label=$3
  if [ ! -f "$src" ]; then
    echo "[probe-cache-sync] $MODE $label: absent at $src, skipped"
    return 0
  fi
  if ! is_json "$src"; then
    echo "[probe-cache-sync] WARNING $MODE $label: $src is not valid JSON, skipped" >&2
    return 0
  fi
  cp "$src" "$dst"
  echo "[probe-cache-sync] $MODE $label: $(wc -c < "$src") bytes $src -> $dst"
}

case "$MODE" in
  restore)
    mkdir -p "$OUTPUT_DIR"
    for f in "${FILES[@]}"; do
      copy_if_json "$STORE/$f" "$OUTPUT_DIR/$f" "$f"
    done
    ;;
  save)
    mkdir -p "$STORE"
    for f in "${FILES[@]}"; do
      copy_if_json "$OUTPUT_DIR/$f" "$STORE/$f" "$f"
    done
    ;;
  *)
    echo "usage: probe-cache-sync.sh restore|save <cache_dir> <output_dir>" >&2
    exit 2
    ;;
esac
