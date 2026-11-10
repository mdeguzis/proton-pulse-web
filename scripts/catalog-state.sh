#!/usr/bin/env bash
set -euo pipefail

# Pull or push a store catalog cache (gog-catalog-cache.json,
# epic-catalog-cache.json) to R2 state (#396). Wraps the fetch in
# update-gog-catalog.yml / update-epic-catalog.yml, which used to commit the
# cache to gh-pages.
#
#   catalog-state.sh pull <cache_dir> <file>   fetch _state/<file> into <cache_dir>
#   catalog-state.sh push <cache_dir> <file>   upload <cache_dir>/<file>
#
# A catalog can always be rebuilt from the store API, so a failed pull is
# logged and the run continues with whatever is in <cache_dir>; the fetch
# then does a full refresh and push saves it. The one-time gh-pages seed for
# the first run after the move went with the branch (#396).
#
# push refuses a catalog with no entries, so an upstream bug that returns
# zero pages without raising can never overwrite the good copy.

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/r2-state.sh"
log() { echo "[catalog-state] $*"; }

cmd="${1:?pull|push required}"
dir="${2:?cache dir required}"
file="${3:?catalog file required}"
mkdir -p "$dir"

entries() {
  python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("catalog") or {}))' "$1"
}

case "$cmd" in
  pull)
    set +e
    bash "$STATE" get "$file" "$dir/$file"
    rc=$?
    set -e
    case "$rc" in
      0) log "$file pulled from R2 ($(entries "$dir/$file") entries)" ;;
      3) log "WARNING: $file is not in R2 state; the fetch will do a full refresh" ;;
      *)
        log "WARNING: could not read $file from R2 (rc=$rc); continuing, the fetch will do a full refresh"
        ;;
    esac
    ;;
  push)
    if [ ! -s "$dir/$file" ]; then
      log "ERROR: $dir/$file is missing or empty; not uploading"
      exit 1
    fi
    n="$(entries "$dir/$file")"
    if [ "$n" -eq 0 ]; then
      log "ERROR: $file has 0 catalog entries; refusing to overwrite R2 state"
      exit 1
    fi
    bash "$STATE" put "$dir/$file" "$file"
    log "$file pushed to R2 ($n entries)"
    ;;
  *)
    log "unknown command '$cmd' (pull|push)"
    exit 1
    ;;
esac
