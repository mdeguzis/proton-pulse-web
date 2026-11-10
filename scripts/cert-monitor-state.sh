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
# real one. A missing history (404) stops the run too: since the one-time
# gh-pages seed went with the branch (#396), a 404 means the R2 copy was lost,
# and starting over would bury that. Set CERT_HISTORY_START_FRESH=1 to begin
# a new series on purpose.
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
        rm -f "$dir/cert-history.json"
        if [ "${CERT_HISTORY_START_FRESH:-0}" = 1 ]; then
          log "no history in R2; CERT_HISTORY_START_FRESH=1, starting a new history"
        else
          log "ERROR: cert-history.json is not in R2 state (404); not starting over. Restore it, or set CERT_HISTORY_START_FRESH=1 for a new series"
          exit 1
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
