#!/usr/bin/env bash
# Restore an R2 bucket from a GitHub Release snapshot (#393).
#
# Downloads the nightly-backup release asset and syncs its contents into the
# target R2 bucket. Two use cases:
#   1. Prod recovery -- restore proton-pulse-data from the latest backup.
#   2. Staging seed -- populate proton-pulse-data-staging from the latest
#      backup. Cuts the first-sync of a fresh staging bucket down to ~5 min.
#
# Env (required):
#   CLOUDFLARE_ACCOUNT_ID   -- picks the R2 S3 endpoint
#   R2_ACCESS_KEY_ID        -- key must have write on TARGET bucket
#   R2_SECRET_ACCESS_KEY
#   GH_TOKEN or GITHUB_TOKEN -- gh CLI auth (for private repos / rate limits)
#
# Env (optional):
#   TARGET_BUCKET   default: proton-pulse-data-staging
#   RELEASE_TAG     default: nightly-backup
#   REPO            default: mdeguzis/proton-pulse-web
#   WORK_DIR        default: mktemp -d
#   PRUNE           default: 0 (1 = pass --delete to aws s3 sync so target
#                   ends up mirror-exact)
#
# Usage:
#   TARGET_BUCKET=proton-pulse-data-staging scripts/restore-r2-from-snapshot.sh
#   TARGET_BUCKET=proton-pulse-data PRUNE=1 scripts/restore-r2-from-snapshot.sh

set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

TARGET_BUCKET="${TARGET_BUCKET:-proton-pulse-data-staging}"
RELEASE_TAG="${RELEASE_TAG:-nightly-backup}"
REPO="${REPO:-mdeguzis/proton-pulse-web}"
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
PRUNE="${PRUNE:-0}"

ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

log() { echo "[restore-r2] $*"; }

log "target=$TARGET_BUCKET release=$RELEASE_TAG repo=$REPO prune=$PRUNE"

# 1. Download the snapshot tarball from the GitHub Release.
TARBALL="$WORK_DIR/proton-pulse-data-snapshot.tar.gz"
log "downloading from release $RELEASE_TAG ..."
gh release download "$RELEASE_TAG" \
  --repo "$REPO" \
  --pattern "proton-pulse-data-snapshot.tar.gz" \
  --dir "$WORK_DIR" \
  --clobber
size=$(du -h "$TARBALL" | awk '{print $1}')
log "downloaded $size"

# 2. Extract.
EXTRACT="$WORK_DIR/extract"
mkdir -p "$EXTRACT"
log "extracting ..."
tar xzf "$TARBALL" -C "$EXTRACT"
extracted_count=$(find "$EXTRACT" -type f | wc -l)
log "extracted $extracted_count files"

# 3. Sync to target bucket. Adaptive retry mirrors publish-cloudflare.sh
#    (#379) so a per-object rate hit does not fail the restore.
aws configure set default.s3.max_concurrent_requests 4
SYNC_ARGS=(--endpoint-url "$ENDPOINT" --content-type application/json --no-progress)
if [[ "$PRUNE" == "1" ]]; then
    SYNC_ARGS+=(--delete)
    log "PRUNE=1 -- extra objects in target will be deleted (mirror-exact restore)"
fi

log "syncing to s3://$TARGET_BUCKET ..."
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
AWS_MAX_ATTEMPTS=6 \
AWS_RETRY_MODE=adaptive \
aws s3 sync "$EXTRACT/data" "s3://$TARGET_BUCKET/data" "${SYNC_ARGS[@]}" > /dev/null

log "done"

# 4. Emit summary.
cat <<EOF
{
  "target_bucket": "$TARGET_BUCKET",
  "release_tag": "$RELEASE_TAG",
  "repo": "$REPO",
  "objects": $extracted_count,
  "tarball_size": "$size",
  "prune": $PRUNE
}
EOF
