#!/usr/bin/env bash
set -euo pipefail

# Durable workflow state in the env's R2 data bucket (#396).
#
# gh-pages used to be the place workflows parked state between runs (cert
# history, catalog caches, pipeline chunk state). It is a leftover from the
# GitHub Pages era and not per-env, so state moves to a `_state/` prefix in
# each env's data bucket: proton-pulse-data for prod, proton-pulse-data-staging
# for staging. Nothing in it is secret; it is readable through the data host
# the same way the files were public on gh-pages.
#
# Usage:
#   r2-state.sh get <name> <dest>   exit 0 fetched, 3 not in the bucket,
#                                   1 any other failure (auth, network, bad JSON)
#   r2-state.sh put <src> <name>    exit 0 uploaded, 1 on any failure
#
# "Not there" and "could not read" are different exit codes on purpose: a
# caller that treats a failed read as "start fresh" would overwrite state that
# cannot be regenerated (cert-history.json is append-only).
#
# Required env:
#   R2_BUCKET               no default, so a staging job cannot write prod by
#                           leaving it out
#   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

log() { echo "[r2-state] $*" >&2; }

usage() {
  log "usage: r2-state.sh get <name> <dest> | put <src> <name>"
  exit 1
}

check_name() {
  # Keys stay flat-ish and predictable: no traversal, no spaces, no leading /.
  if ! [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || [[ "$1" == *..* ]]; then
    log "refusing state name '$1'"
    exit 1
  fi
}

check_json() {
  # A .json state file that does not parse is a failure, never a fresh start.
  case "$2" in *.json) ;; *) return 0 ;; esac
  if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null; then
    log "$2 is not valid JSON ($1)"
    return 1
  fi
}

r2aws() {
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="auto" \
  AWS_MAX_ATTEMPTS=5 \
  AWS_RETRY_MODE=adaptive \
  aws "$@" --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift

: "${R2_BUCKET:?R2_BUCKET required (proton-pulse-data or proton-pulse-data-staging)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

case "$cmd" in
  get)
    [ $# -eq 2 ] || usage
    name="$1"; dest="$2"
    check_name "$name"
    key="_state/$name"
    tmp="$(mktemp)"
    err="$(mktemp)"
    trap 'rm -f "$tmp" "$err"' EXIT
    if ! r2aws s3api get-object --bucket "$R2_BUCKET" --key "$key" "$tmp" >/dev/null 2>"$err"; then
      if grep -qE 'NoSuchKey|\(404\)|Not Found' "$err"; then
        log "get $R2_BUCKET/$key: not in the bucket"
        exit 3
      fi
      log "get $R2_BUCKET/$key failed: $(tr '\n' ' ' < "$err")"
      exit 1
    fi
    check_json "$tmp" "$name" || exit 1
    mkdir -p "$(dirname "$dest")"
    mv "$tmp" "$dest"
    log "get $R2_BUCKET/$key: $(wc -c < "$dest") bytes to $dest"
    ;;
  put)
    [ $# -eq 2 ] || usage
    src="$1"; name="$2"
    check_name "$name"
    key="_state/$name"
    if [ ! -s "$src" ]; then
      log "put $name: $src is missing or empty"
      exit 1
    fi
    check_json "$src" "$name" || exit 1
    type="application/octet-stream"
    case "$name" in *.json) type="application/json" ;; esac
    # no-store so a read through the public data host never gets a stale copy.
    r2aws s3 cp "$src" "s3://$R2_BUCKET/$key" \
      --content-type "$type" --cache-control no-store --no-progress >/dev/null
    log "put $R2_BUCKET/$key: $(wc -c < "$src") bytes"
    ;;
  *)
    usage
    ;;
esac
