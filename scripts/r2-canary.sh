#!/usr/bin/env bash
set -uo pipefail

# R2 canary: a fast integration test that each R2 bucket is writable, listable,
# readable and deletable with the CURRENT S3 credentials. It catches token /
# permission regressions -- e.g. AccessDenied on ListObjectsV2 after a bucket
# split (#380) or an R2 key roll -- in SECONDS, instead of discovering them
# ~40 min into a data sync during a real deploy.
#
# It exercises the exact operations the deploy's `aws s3 sync` relies on:
#   PutObject, ListObjectsV2, GetObject, DeleteObject.
# Objects are written under a .canary/ prefix and deleted immediately, so this
# never touches served data.
#
# Env (same secrets the deploy uses):
#   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
# Args: bucket names to test (default: the three known buckets).
# Exit: 0 = every bucket healthy; 1 = one or more failed.

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

BUCKETS=("$@")
[ "${#BUCKETS[@]}" -gt 0 ] || BUCKETS=(proton-pulse-data proton-pulse-data-staging proton-pulse-data-backups)

ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

KEY=".canary/canary-$(date -u +%Y%m%dT%H%M%SZ)-$$.txt"
BODY="r2-canary run=${GITHUB_RUN_ID:-local} at=$(date -u +%FT%TZ)"
SRC="$(mktemp)"; printf '%s' "$BODY" > "$SRC"
GOT="$(mktemp)"
trap 'rm -f "$SRC" "$GOT"' EXIT

r2() { aws "$@" --endpoint-url "$ENDPOINT" --no-cli-pager 2>&1; }

overall=0
for b in "${BUCKETS[@]}"; do
  echo "== bucket: $b (key $KEY) =="
  ok=1

  if out=$(r2 s3api put-object --bucket "$b" --key "$KEY" --body "$SRC" --content-type text/plain); then
    echo "  [ok]   PutObject"
  else
    echo "  [FAIL] PutObject -- $(echo "$out" | tail -1)"; ok=0
  fi

  if out=$(r2 s3api list-objects-v2 --bucket "$b" --prefix ".canary/" --max-items 1); then
    echo "  [ok]   ListObjectsV2"
  else
    echo "  [FAIL] ListObjectsV2 -- $(echo "$out" | tail -1)"; ok=0
  fi

  if aws s3api get-object --bucket "$b" --key "$KEY" "$GOT" --endpoint-url "$ENDPOINT" --no-cli-pager >/dev/null 2>&1 \
     && [ "$(cat "$GOT")" = "$BODY" ]; then
    echo "  [ok]   GetObject + content match"
  else
    echo "  [FAIL] GetObject / content mismatch"; ok=0
  fi

  if out=$(r2 s3api delete-object --bucket "$b" --key "$KEY"); then
    echo "  [ok]   DeleteObject"
  else
    echo "  [FAIL] DeleteObject (a stray .canary/ object was left) -- $(echo "$out" | tail -1)"; ok=0
  fi

  if [ "$ok" = 1 ]; then echo "  => PASS"; else echo "  => FAIL"; overall=1; fi
  echo
done

if [ "$overall" = 0 ]; then
  echo "R2 canary: all ${#BUCKETS[@]} bucket(s) healthy (PutObject / ListObjectsV2 / GetObject / DeleteObject)."
else
  echo "R2 canary: FAILURE. A bucket op was denied -- check the R2 API token scope (needs Object Read & Write on ALL buckets) and the bucket names." >&2
fi
exit "$overall"
