#!/usr/bin/env bash
# Snapshot an R2 bucket into a compressed tarball + upload to the backups bucket.
#
# Rationale (#381): a full pipeline re-run from scratch takes ~2h and burns
# through Steam appdetails rate limits. A pre-baked tarball makes restore a
# 5-min tar + s3 sync, and doubles as the seed for a fresh staging bucket.
#
# Env (required):
#   CLOUDFLARE_ACCOUNT_ID   -- picks the R2 S3 endpoint
#   R2_ACCESS_KEY_ID        -- key must have read on SOURCE bucket + write on BACKUPS bucket
#   R2_SECRET_ACCESS_KEY
#
# Env (optional):
#   SOURCE_BUCKET   default: proton-pulse-data
#   BACKUPS_BUCKET  default: proton-pulse-data-backups
#   SNAPSHOT_PREFIX default: snapshots
#   LATEST_NAME     default: latest.tar.gz
#   WORK_DIR        default: mktemp -d
#
# Usage:
#   scripts/backup-r2-snapshot.sh
#
# Emits (to BACKUPS_BUCKET):
#   <SNAPSHOT_PREFIX>/YYYY-MM-DD.tar.gz    -- dated point-in-time snapshot
#   <LATEST_NAME>                          -- alias to newest (overwritten every run)

set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

SOURCE_BUCKET="${SOURCE_BUCKET:-proton-pulse-data}"
BACKUPS_BUCKET="${BACKUPS_BUCKET:-proton-pulse-data-backups}"
SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX:-snapshots}"
LATEST_NAME="${LATEST_NAME:-latest.tar.gz}"
WORK_DIR="${WORK_DIR:-$(mktemp -d)}"

DATE_UTC="$(date -u +%Y-%m-%d)"
SNAPSHOT_NAME="${SNAPSHOT_PREFIX}/${DATE_UTC}.tar.gz"
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

log() { echo "[backup-r2-snapshot] $*"; }

log "source=$SOURCE_BUCKET backups=$BACKUPS_BUCKET snapshot=$SNAPSHOT_NAME work=$WORK_DIR"

# 1. Pull the entire source bucket down to WORK_DIR/src/
#    Adaptive retry + throttled concurrency mirror publish-cloudflare.sh's
#    settings (#379) so R2's per-object rate limit does not fail the pull.
mkdir -p "$WORK_DIR/src"
aws configure set default.s3.max_concurrent_requests 4
log "pulling source bucket (this is the slow part) ..."
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
AWS_MAX_ATTEMPTS=6 \
AWS_RETRY_MODE=adaptive \
aws s3 sync "s3://$SOURCE_BUCKET" "$WORK_DIR/src" \
    --endpoint-url "$ENDPOINT" \
    --no-progress \
    > /dev/null
pulled_count=$(find "$WORK_DIR/src" -type f | wc -l)
log "pulled $pulled_count objects"

# 2. Tar + gzip. Store paths relative to WORK_DIR/src so the archive extracts
#    cleanly into any target directory ("tar xzf ... -C /target/").
TARBALL="$WORK_DIR/snapshot.tar.gz"
log "creating tarball ..."
tar czf "$TARBALL" -C "$WORK_DIR/src" .
tarball_size=$(du -h "$TARBALL" | awk '{print $1}')
log "tarball size: $tarball_size"

# 3. Upload the dated snapshot + overwrite latest. Both hit the SAME body so
#    doing two separate cp calls costs an extra upload, but keeps the atomic
#    property: if the dated snapshot fails, latest stays pointing at the
#    previous good tarball.
log "uploading $SNAPSHOT_NAME ..."
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
aws s3 cp "$TARBALL" "s3://$BACKUPS_BUCKET/$SNAPSHOT_NAME" \
    --endpoint-url "$ENDPOINT" \
    --content-type application/gzip \
    --no-progress \
    > /dev/null

log "uploading $LATEST_NAME ..."
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="auto" \
aws s3 cp "$TARBALL" "s3://$BACKUPS_BUCKET/$LATEST_NAME" \
    --endpoint-url "$ENDPOINT" \
    --content-type application/gzip \
    --no-progress \
    > /dev/null

# 4. Emit a JSON summary so a caller (workflow) can decide whether to alert.
cat <<EOF
{
  "date_utc": "$DATE_UTC",
  "source_bucket": "$SOURCE_BUCKET",
  "backups_bucket": "$BACKUPS_BUCKET",
  "snapshot_key": "$SNAPSHOT_NAME",
  "latest_key": "$LATEST_NAME",
  "objects": $pulled_count,
  "tarball_size": "$tarball_size"
}
EOF

log "done"
