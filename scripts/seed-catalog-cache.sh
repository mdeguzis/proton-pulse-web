#!/usr/bin/env bash
# Seed a store catalog cache from gh-pages, but only when it is actually newer.
#
# The pipeline restores .cache/ from the Actions cache first, then seeds these
# two files from gh-pages so a catalog rebuilt by the dedicated weekly
# workflows wins over a stale copy carried in the Actions cache.
#
# That assumed gh-pages is the fresher of the two. It was not. The weekly
# workflow only refreshed when the cache had already expired, and its cadence
# equals the TTL, so it kept no-opping and gh-pages froze -- while finalize
# re-fetched the catalog in-line and saved a genuinely fresh copy to the
# Actions cache. The unconditional `cp` then clobbered that fresh copy with the
# frozen one on every run, so the re-fetch happened again, and again.
#
# Comparing `_ts` keeps the intent (a real rebuild wins) without the inversion.
#
# Usage: seed-catalog-cache.sh <gh-pages-dir> <cache-dir> <file>...
set -euo pipefail

SRC_DIR="${1:?gh-pages dir required}"; shift
DST_DIR="${1:?cache dir required}"; shift

mkdir -p "$DST_DIR"

# Print the `_ts` epoch from a catalog cache, or 0 when absent/unreadable.
cache_ts() {
  python3 -c "
import json,sys
try:
    print(int(json.load(open(sys.argv[1])).get('_ts') or 0))
except Exception:
    print(0)
" "$1" 2>/dev/null || echo 0
}

for f in "$@"; do
  src="$SRC_DIR/$f"
  dst="$DST_DIR/$f"
  if [ ! -f "$src" ]; then
    echo "[seed-catalog] $f: not on gh-pages, keeping whatever the Actions cache had"
    continue
  fi
  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    echo "[seed-catalog] $f: seeded from gh-pages (no local copy)"
    continue
  fi
  src_ts="$(cache_ts "$src")"
  dst_ts="$(cache_ts "$dst")"
  if [ "$src_ts" -gt "$dst_ts" ]; then
    cp "$src" "$dst"
    echo "[seed-catalog] $f: gh-pages is newer (${src_ts} > ${dst_ts}), seeded"
  else
    echo "[seed-catalog] $f: local cache is newer or equal (${dst_ts} >= ${src_ts}), kept"
  fi
done
