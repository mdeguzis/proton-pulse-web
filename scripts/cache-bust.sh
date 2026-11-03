#!/usr/bin/env bash
# cache-bust.sh - append a content-hash ?v= to every local css/ and js/
# reference in the site's HTML pages AND to relative ES module import/export
# statements inside JS files, so a deploy invalidates browser and CDN cache
# for exactly the assets that changed.
#
# A JS file's hash covers its own source plus the hashes of everything it
# imports (static and dynamic), so a change deep in the module graph changes
# every importer's ?v= up to the HTML (#595). Idempotent: hashes come from
# *stripped* content (?v= params removed) and import cycles hash as a group,
# so a second run changes nothing. Run before committing CSS/JS changes
# (wired into `make build`). Logic lives in scripts/cache_bust.py.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/cache_bust.py
