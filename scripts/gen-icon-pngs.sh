#!/usr/bin/env bash
set -euo pipefail

# Rasterize the Steam device / signage SVG masters to transparent PNGs at a
# set of common sizes. Re-run any time the SVG sources under assets/icons/steam
# change. Output lands in assets/icons/steam/png/<name>-<size>.png.
#
# Requires rsvg-convert (librsvg). The SVGs are the source of truth; the PNGs
# are generated artifacts for contexts that cannot use inline SVG.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/assets/icons/steam"
OUT_DIR="$SRC_DIR/png"
SIZES=(16 24 32 48 64 128)

command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert not found (install librsvg)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

count=0
for svg in "$SRC_DIR"/*.svg; do
  name="$(basename "$svg" .svg)"
  for size in "${SIZES[@]}"; do
    rsvg-convert -w "$size" -h "$size" "$svg" -o "$OUT_DIR/${name}-${size}.png"
    count=$((count + 1))
  done
done

echo "generated $count PNGs from $(ls "$SRC_DIR"/*.svg | wc -l) SVG masters into $OUT_DIR"
