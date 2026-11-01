#!/usr/bin/env bash
set -euo pipefail

# Pull or push the cert monitor's files to R2 state (#396). Wraps
# cert-monitor.sh in cert-monitor.yml.
#
#   cert-monitor-state.sh pull <dir>   fetch cert-history.json into <dir>
#   cert-monitor-state.sh push <dir>   upload cert-status.json + cert-history.json
#
# cert-history.json is the append-only burndown series and cannot be
# regenerated, so pull fails on any read error rather than letting
# cert-monitor.sh start a fresh history that push would then save over the
# real one. When R2 has no copy yet (first run after the move off gh-pages),
# it is seeded once from origin/gh-pages. That fallback goes away when the
# branch is archived.
#
# cert-status.json is a snapshot that cert-monitor.sh rewrites every run, so
# it is never pulled.

HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="$HERE/r2-state.sh"
log() { echo "[cert-state] $*"; }

cmd="${1:?pull|push required}"
dir="${2:?dir required}"
mkdir -p "$dir"

case "$cmd" in
  pull)
    set +e
    bash "$STATE" get cert-history.json "$dir/cert-history.json"
    rc=$?
    set -e
    case "$rc" in
      0) log "history pulled from R2 ($(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$dir/cert-history.json") points)" ;;
      3)
        log "no history in R2 yet; seeding once from origin/gh-pages (#396 migration)"
        if git -C "$HERE/.." fetch -q --depth 1 origin gh-pages \
           && git -C "$HERE/.." show origin/gh-pages:cert-history.json > "$dir/cert-history.json" \
           && [ -s "$dir/cert-history.json" ]; then
          log "seeded $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$dir/cert-history.json") points from gh-pages"
        else
          rm -f "$dir/cert-history.json"
          log "gh-pages has no cert-history.json either; starting a new history"
        fi
        ;;
      *)
        log "ERROR: could not read cert-history.json from R2 (rc=$rc); not running, so the history is not overwritten"
        exit 1
        ;;
    esac
    ;;
  push)
    bash "$STATE" put "$dir/cert-status.json" cert-status.json
    bash "$STATE" put "$dir/cert-history.json" cert-history.json
    ;;
  *)
    log "unknown command '$cmd' (pull|push)"
    exit 1
    ;;
esac
