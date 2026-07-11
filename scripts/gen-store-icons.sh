#!/usr/bin/env bash
set -euo pipefail

# Rasterize the store icon masters to PNGs at common sizes. Steam is an SVG
# master (crisp at any size); GOG and Epic are raster app-icon masters that
# get downscaled. Re-run when any master under assets/icons/store changes.
#
# Requires rsvg-convert (librsvg) and ImageMagick (magick).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/assets/icons/store"
OUT_DIR="$SRC_DIR/png"
SIZES=(16 24 32 48 64 128)

command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert not found (install librsvg)" >&2; exit 1; }
command -v magick >/dev/null 2>&1 || { echo "magick not found (install ImageMagick)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

count=0
for size in "${SIZES[@]}"; do
  rsvg-convert -w "$size" -h "$size" "$SRC_DIR/steam.svg" -o "$OUT_DIR/steam-${size}.png"
  count=$((count + 1))
  for name in gog epic; do
    magick "$SRC_DIR/${name}.png" -resize "${size}x${size}" "$OUT_DIR/${name}-${size}.png"
    count=$((count + 1))
  done
done

echo "generated $count store PNGs into $OUT_DIR"
