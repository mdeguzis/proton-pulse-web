#!/usr/bin/env bash
set -euo pipefail

# Nightly encrypted full database backup (#580).
#
# Dumps every public table plus auth.users / auth.identities
# (scripts/backup_db.py), tars the dump, encrypts it to an age public key and
# uploads it to the private R2 backups bucket. Only the public key is ever in
# CI; the private key stays offline with the owner, so neither GitHub nor
# Cloudflare can read the backup. Objects older than RETENTION_DAYS under the
# db/ prefix are pruned after a successful upload.
#
# Env:
#   SUPABASE_TOKEN                     Management API token
#   BACKUP_AGE_RECIPIENT               age public key (age1...)
#   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   BACKUP_BUCKET     default: proton-pulse-data-backups
#   RETENTION_DAYS    default: 30
#   DRY_RUN=1         encrypt but skip upload and prune
#
# Restore: see the Restore-Runbook wiki, "Database restore from the
# encrypted backup".

: "${SUPABASE_TOKEN:?SUPABASE_TOKEN required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT required (age public key)}"
BUCKET="${BACKUP_BUCKET:-proton-pulse-data-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

case "$BACKUP_AGE_RECIPIENT" in
  age1*) ;;
  *) echo "[backup-db] ERROR: BACKUP_AGE_RECIPIENT is not an age public key" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="db-${STAMP}.tar.gz.age"

python3 -m scripts.backup_db --out "$WORK/dump"
tar czf "$WORK/db.tar.gz" -C "$WORK/dump" .
age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/$NAME" "$WORK/db.tar.gz"
rm -rf "$WORK/dump" "$WORK/db.tar.gz"

# Never upload anything that is not an age file.
if [ "$(head -c 21 "$WORK/$NAME")" != "age-encryption.org/v1" ]; then
  echo "[backup-db] ERROR: encrypted output has no age header; refusing to upload" >&2
  exit 1
fi
SIZE=$(wc -c < "$WORK/$NAME")
echo "[backup-db] encrypted $NAME ($SIZE bytes)"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[backup-db] DRY_RUN=1, skipping upload and prune"
  exit 0
fi

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"
ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

aws s3 cp "$WORK/$NAME" "s3://$BUCKET/db/$NAME" --endpoint-url "$ENDPOINT" --no-progress
aws s3 cp "s3://$BUCKET/db/$NAME" "s3://$BUCKET/db/latest.tar.gz.age" --endpoint-url "$ENDPOINT" --no-progress
echo "[backup-db] uploaded s3://$BUCKET/db/$NAME and db/latest.tar.gz.age"

# The backups bucket once had a public custom domain (#381). Encryption keeps
# the contents safe either way, but a copy of the user database must not be
# downloadable by anyone. If it is reachable publicly, take it down and fail.
for base in ${BACKUP_PUBLIC_URLS:-https://backups.proton-pulse.com}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$base/db/$NAME" || echo 000)
  if [ "$code" = "200" ]; then
    aws s3 rm "s3://$BUCKET/db/$NAME" --endpoint-url "$ENDPOINT" --only-show-errors
    aws s3 rm "s3://$BUCKET/db/latest.tar.gz.age" --endpoint-url "$ENDPOINT" --only-show-errors
    echo "[backup-db] ERROR: $base/db/$NAME is publicly readable; removed the upload. Detach the public domain from $BUCKET." >&2
    exit 1
  fi
  echo "[backup-db] public check: $base/db/ answers $code (not readable)"
done

# Prune by the timestamp in the name (it sorts lexically). The newest
# KEEP_MIN backups always survive, so a stopped schedule never ages out the
# last good copies.
KEEP_MIN=7
CUTOFF="db/db-$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%dT%H%M%SZ).tar.gz.age"
mapfile -t KEYS < <(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "db/db-" \
  --endpoint-url "$ENDPOINT" --query 'Contents[].Key' --output text | tr '\t' '\n' \
  | grep -E '^db/db-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.tar\.gz\.age$' | sort)
pruned=0
for ((i = 0; i < ${#KEYS[@]} - KEEP_MIN; i++)); do
  key="${KEYS[$i]}"
  [[ "$key" < "$CUTOFF" ]] || break
  aws s3 rm "s3://$BUCKET/$key" --endpoint-url "$ENDPOINT" --only-show-errors
  pruned=$((pruned + 1))
done
echo "[backup-db] kept $(( ${#KEYS[@]} - pruned )) backups, pruned $pruned older than ${RETENTION_DAYS} days"
