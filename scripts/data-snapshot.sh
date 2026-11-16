#!/usr/bin/env bash
set -euo pipefail

# The nightly's historical data/ base, kept in R2 state (#396).
#
# Finalize starts from a small artifact (the fresh dump) and fills in every
# game probed in earlier runs from a copy of the previous output. That copy
# used to be gh-pages' data/, which stopped being written at the Cloudflare
# move (last change 2026-09-20), so every nightly since rebuilt from a stale
# base. Now each successful Cloudflare deploy pushes data/ as one archive,
# and the next run starts from it.
#
#   data-snapshot.sh pull <output_dir>
#       Download <STATE_BASE>/data-snapshot.tar.zst over the public data host
#       and extract it into <output_dir>/data without overwriting files that
#       are already there (the artifact wins, same as the old `cp -rn`).
#       A missing (404), unreachable or corrupt snapshot exits 1: building on
#       an empty base would publish a search index missing most games. The
#       gh-pages data/ fallback went with the branch (#396); a lost snapshot
#       is restored from the nightly-backup release (Restore-Runbook).
#   data-snapshot.sh push <output_dir>
#       Archive <output_dir>/data and upload it with r2-state.sh (needs the
#       R2 env). Refuses when data/ is missing, or has fewer than
#       SNAPSHOT_MIN_RATIO (default 0.9) of the app dirs the pull started
#       from, so a broken run cannot shrink the next night's base.
#
# Env:
#   STATE_BASE           pull source, default https://data.proton-pulse.com/_state
#                        (prod's, for staging runs too)
#   SNAPSHOT_COUNT_FILE  pull writes the base's app-dir count here, push reads it
#   SNAPSHOT_MIN_RATIO   default 0.9

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="data-snapshot.tar.zst"
log() { echo "[data-snapshot] $*"; }

cmd="${1:?pull|push required}"
out="${2:?output dir required}"

# 0 for a dir that does not exist yet. find fails on it, and under pipefail
# that used to kill the script with no log line.
app_dirs() { { find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true; } | wc -l; }

record_count() {
  if [ -n "${SNAPSHOT_COUNT_FILE:-}" ]; then
    app_dirs "$out/data" > "$SNAPSHOT_COUNT_FILE"
  fi
}

fail_pull() {
  log "ERROR: $1; refusing to build on an empty base (restore the snapshot from the nightly-backup release, see Restore-Runbook)"
  exit 1
}

case "$cmd" in
  pull)
    base="${STATE_BASE:-https://data.proton-pulse.com/_state}"
    tmp="$(mktemp)"; hdr="$(mktemp)"
    trap 'rm -f "$tmp" "$hdr"' EXIT
    # curl prints 000 via -w on a transport failure and exits non-zero.
    code="$(curl -sS -D "$hdr" -o "$tmp" -w '%{http_code}' --max-time 600 "$base/$NAME" 2>/dev/null)" || true
    code="${code:-000}"
    if [ "$code" != 200 ]; then
      if [ "$code" = 404 ]; then fail_pull "no snapshot at $base/$NAME (404)"; else fail_pull "snapshot download failed (HTTP $code)"; fi
    fi
    if ! zstd -q -t "$tmp" 2>/dev/null; then
      fail_pull "snapshot is corrupt (zstd -t failed, $(wc -c < "$tmp") bytes)"
    fi
    modified="$(grep -i '^last-modified:' "$hdr" | cut -d' ' -f2- | tr -d '\r' || true)"
    before="$(app_dirs "$out/data")"
    mkdir -p "$out/data"
    # --skip-old-files: files already present (the fresh artifact) win.
    tar -C "$out" --zstd --skip-old-files -xf "$tmp"
    log "pulled $base/$NAME ($(wc -c < "$tmp") bytes, last-modified ${modified:-unknown}): $before app dirs from the artifact, $(app_dirs "$out/data") after merge"
    record_count
    ;;
  push)
    if [ ! -d "$out/data" ]; then
      log "ERROR: $out/data is missing; not uploading"
      exit 1
    fi
    now="$(app_dirs "$out/data")"
    if [ -n "${SNAPSHOT_COUNT_FILE:-}" ] && [ -s "$SNAPSHOT_COUNT_FILE" ]; then
      base_n="$(cat "$SNAPSHOT_COUNT_FILE")"
      ratio="${SNAPSHOT_MIN_RATIO:-0.9}"
      if python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= float(sys.argv[3]) * int(sys.argv[2]) else 1)' "$now" "$base_n" "$ratio"; then
        :
      else
        log "ERROR: data/ has $now app dirs, under $ratio of the $base_n this run started from; not overwriting the snapshot"
        exit 1
      fi
    fi
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    tar -C "$out" --zstd -cf "$work/$NAME" data
    log "archived $now app dirs into $(wc -c < "$work/$NAME") bytes"
    bash "$HERE/r2-state.sh" put "$work/$NAME" "$NAME"
    log "pushed $NAME to ${R2_BUCKET:-?}"
    ;;
  *)
    log "unknown command '$cmd' (pull|push)"
    exit 1
    ;;
esac
