#!/usr/bin/env bash
# Fetch the plugin-sourced data files (form-schema.json, scoring-info.json)
# from decky-proton-pulse main into a deploy output dir.
#
# The pipeline does not generate these; the plugin repo is their source of
# truth. They must be in the dir handed to publish-cloudflare.sh, otherwise CF
# Pages serves the SPA HTML fallback (200 text/html) for both paths and the
# submit form breaks with "Could not load form-schema.json" (#546).
#
# Fails loud: a failed fetch or a non-JSON body (an HTML error page, an empty
# response) exits non-zero so the deploy never ships without them.
#
# Usage: bash scripts/fetch-plugin-data.sh <out_dir>
#   PLUGIN_DATA_BASE  override the source base URL (tests use file://)

set -euo pipefail

OUT_DIR=${1:?usage: fetch-plugin-data.sh <out_dir>}
BASE=${PLUGIN_DATA_BASE:-https://raw.githubusercontent.com/mdeguzis/decky-proton-pulse/main/src/data}
FILES=(form-schema.json scoring-info.json)

mkdir -p "$OUT_DIR"
for f in "${FILES[@]}"; do
  url="$BASE/$f"
  if ! curl -fsSL --retry 3 --max-time 30 "$url" -o "$OUT_DIR/$f"; then
    echo "[fetch-plugin-data] ERROR: fetch failed for $f from $url" >&2
    rm -f "$OUT_DIR/$f"
    exit 1
  fi
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT_DIR/$f" 2>/dev/null; then
    echo "[fetch-plugin-data] ERROR: $f from $url is not valid JSON ($(head -c 60 "$OUT_DIR/$f" | tr -d '\n'))" >&2
    rm -f "$OUT_DIR/$f"
    exit 1
  fi
  echo "[fetch-plugin-data] fetched $f ($(wc -c < "$OUT_DIR/$f") bytes) from $url"
done
