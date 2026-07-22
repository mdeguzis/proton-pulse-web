#!/usr/bin/env bash
# Restore an R2 bucket from a tarball snapshot (#381).
#
# Two use cases:
#   1. Prod recovery -- pull backups.proton-pulse.com/latest.tar.gz and
#      sync into proton-pulse-data.
#   2. Staging seed -- pull the same latest, sync into
#      proton-pulse-data-staging. Cuts the ~30-90 min first-sync of a fresh
#      staging bucket down to ~5 min.
#
# Env (required):
#   CLOUDFLARE_ACCOUNT_ID   -- picks the R2 S3 endpoint
#   R2_ACCESS_KEY_ID        -- key must have write on TARGET bucket
#   R2_SECRET_ACCESS_KEY
#
# Env (optional):
#   TARGET_BUCKET   default: proton-pulse-data-staging
#   BACKUPS_HOST    default: https://backups.proton-pulse.com
#   SNAPSHOT_NAME   default: latest.tar.gz (or "snapshots/YYYY-MM-DD.tar.gz")
#   WORK_DIR        default: mktemp -d
#   PRUNE           default: 0 (1 = pass --delete to aws s3 sync so target ends up mirror-exact)
#
# Usage:
#   TARGET_BUCKET=proton-pulse-data-staging scripts/restore-r2-from-snapshot.sh
#   SNAPSHOT_NAME=snapshots/2026-07-21.tar.gz TARGET_BUCKET=proton-pulse-data scripts/restore-r2-from-snapshot.sh

set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

TARGET_BUCKET="${TARGET_BUCKET:-proton-pulse-data-staging}"
BACKUPS_HOST="${BACKUPS_HOST:-https://backups.proton-pulse.com}"
SNAPSHOT_NAME="${SNAPSHOT_NAME:-latest.tar.gz}"
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
PRUNE="${PRUNE:-0}"

# Enforce https on BACKUPS_HOST as a belt-and-braces guard so a caller cannot
# smuggle a file:// or http:// URL. Same discipline as pcgamingwiki.py.
if [[ "$BACKUPS_HOST" != https://* ]]; then
    echo "[restore-r2] refusing non-https BACKUPS_HOST: $BACKUPS_HOST" >&2
    exit 2
fi
# Belt: only allow snapshots/ prefix or a top-level *.tar.gz. This blocks any
# attempt to redirect the download to an arbitrary path.
case "$SNAPSHOT_NAME" in
    *..* | /*)
        echo "[restore-r2] refusing suspicious SNAPSHOT_NAME: $SNAPSHOT_NAME" >&2
        exit 2
        ;;
    latest.tar.gz|snapshots/*.tar.gz)
        ;;
    *)
        echo "[restore-r2] SNAPSHOT_NAME must be 'latest.tar.gz' or 'snapshots/YYYY-MM-DD.tar.gz'" >&2
        exit 2
        ;;
esac

ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

log() { echo "[restore-r2] $*"; }

log "target=$TARGET_BUCKET snapshot=$SNAPSHOT_NAME work=$WORK_DIR prune=$PRUNE"

# 1. Download the snapshot.
TARBALL="$WORK_DIR/snapshot.tar.gz"
log "downloading $BACKUPS_HOST/$SNAPSHOT_NAME ..."
curl -fsSL "$BACKUPS_HOST/$SNAPSHOT_NAME" -o "$TARBALL"
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
aws s3 sync "$EXTRACT" "s3://$TARGET_BUCKET" "${SYNC_ARGS[@]}" > /dev/null

log "done"

# 4. Emit summary.
cat <<EOF
{
  "target_bucket": "$TARGET_BUCKET",
  "snapshot_used": "$SNAPSHOT_NAME",
  "objects": $extracted_count,
  "tarball_size": "$size",
  "prune": $PRUNE
}
EOF
