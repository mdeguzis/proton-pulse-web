#!/usr/bin/env bash
# Tar the pipeline output and upload as a GitHub Release asset (#393).
#
# Replaces the old backup-r2-snapshot.sh approach: instead of pulling 75k
# objects from R2 back down to tar them, we tar the local /tmp/protondb-output/
# data tree (already on disk at the end of the pipeline run) and attach it to
# a rolling pre-release. The backup lives on GitHub, off Cloudflare.
#
# The ProtonDB probe cache rides along as a second asset. It is the one
# derived file that is slow to rebuild (a cold re-probe of every game into
# ProtonDB and Steam rate limits), and its working copy now lives in R2 state
# (#396), so this keeps a copy off Cloudflare.
#
# Usage: scripts/backup-to-release.sh <data_dir>
#   data_dir -- path containing the pipeline's per-game data/ tree
#
# Env (required):
#   GH_TOKEN or GITHUB_TOKEN -- gh CLI auth
#
# Env (optional):
#   RELEASE_TAG  default: nightly-backup
#   REPO         default: mdeguzis/proton-pulse-web
#   PROBE_CACHE  default: .cache/protondb-summary-probe-cache.json

set -euo pipefail

DATA_DIR="${1:?data_dir required (path to pipeline output with data/)}"
RELEASE_TAG="${RELEASE_TAG:-nightly-backup}"
REPO="${REPO:-mdeguzis/proton-pulse-web}"
PROBE_CACHE="${PROBE_CACHE:-.cache/protondb-summary-probe-cache.json}"

log() { echo "[backup-to-release] $*"; }

if [ ! -d "$DATA_DIR/data" ]; then
  log "ERROR: $DATA_DIR/data not found -- nothing to back up"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL="$WORK/proton-pulse-data-snapshot.tar.gz"
PROBE_ASSET="$WORK/protondb-probe-cache.json.gz"
DATE_UTC="$(date -u +%Y-%m-%d)"

# 1. Create the tarball from the local pipeline output.
log "creating tarball from $DATA_DIR/data ..."
tar czf "$TARBALL" -C "$DATA_DIR" data
tarball_size=$(du -h "$TARBALL" | awk '{print $1}')
file_count=$(find "$DATA_DIR/data" -type f | wc -l)
log "tarball: $tarball_size ($file_count files)"

# 2. Ensure the rolling pre-release exists. Create if missing.
if ! gh release view "$RELEASE_TAG" --repo "$REPO" > /dev/null 2>&1; then
  log "creating pre-release $RELEASE_TAG ..."
  gh release create "$RELEASE_TAG" \
    --repo "$REPO" \
    --title "Nightly Data Backup" \
    --notes "Rolling pre-release. Asset is overwritten on every pipeline run. Use \`gh release download $RELEASE_TAG\` to restore." \
    --prerelease
fi

# 3. Upload the tarball (and the probe cache), overwriting the previous assets.
assets=("$TARBALL")
probe_note="not included (no probe cache in this run)"
if [ -s "$PROBE_CACHE" ]; then
  gzip -c "$PROBE_CACHE" > "$PROBE_ASSET"
  assets+=("$PROBE_ASSET")
  probe_note="$(du -h "$PROBE_ASSET" | awk '{print $1}') (protondb-probe-cache.json.gz)"
else
  log "WARNING: $PROBE_CACHE missing or empty; backing up data/ without the probe cache"
fi
log "uploading ${#assets[@]} asset(s) to release $RELEASE_TAG ..."
gh release upload "$RELEASE_TAG" "${assets[@]}" \
  --repo "$REPO" \
  --clobber

# 4. Update the release body with the latest metadata so a human can see
#    at a glance when the last backup was.
gh release edit "$RELEASE_TAG" \
  --repo "$REPO" \
  --notes "Rolling nightly backup of per-game data. Overwritten on every pipeline run.

Last updated: $DATE_UTC
Objects: $file_count
Tarball size: $tarball_size
Probe cache: $probe_note

Restore: \`gh release download $RELEASE_TAG --repo $REPO && tar xzf proton-pulse-data-snapshot.tar.gz -C /tmp/restore\`"

log "done ($DATE_UTC, $file_count objects, $tarball_size, probe cache $probe_note)"
