#!/usr/bin/env bash
# cache-bust.sh - append a content-hash ?v= to every local css/ and js/
# reference in the site's HTML pages AND to relative ES module import/export
# statements inside JS files, so a deploy invalidates browser and CDN cache
# for exactly the assets that changed.
#
# Idempotent: hashes are computed from *stripped* file content (?v= params
# removed before hashing) so import cycles between JS modules don't keep
# the hashes oscillating. Run before committing CSS/JS changes (wired into
# `make build`). Logic lives in scripts/cache_bust.py.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/cache_bust.py
