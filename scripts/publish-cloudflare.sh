#!/usr/bin/env bash
set -euo pipefail

# Publish the site to Cloudflare (#362): sync the per-game data/ buckets to R2,
# then deploy the shell + small top-level data + data-config.json to Cloudflare
# Pages. This is the DEPLOY_TARGET=cloudflare half of the pluggable deploy; the
# GitHub Pages path is unchanged and still selectable.
#
# Why the split: there are 75k+ files under data/, well over the Cloudflare Pages
# 20,000-file cap, so data/ lives in R2 (served at data.proton-pulse.com) while
# Pages holds the shell and the few dozen small top-level data files.
#
# Usage: publish-cloudflare.sh <output_dir> <repo_dir>
#   output_dir -- pipeline output: contains data/ and the top-level *.json
#   repo_dir   -- repo checkout: source shell files + gh-pages-manifest.txt
#
# Required env (CI secrets):
#   CLOUDFLARE_ACCOUNT_ID
#   CLOUDFLARE_API_TOKEN        Pages:Edit for `wrangler pages deploy`
#   R2_ACCESS_KEY_ID            R2 S3 access key id  (data/ sync)
#   R2_SECRET_ACCESS_KEY        R2 S3 secret
# Optional env (have sane defaults):
#   PAGES_PROJECT   default: proton-pulse-web
#   PAGES_BRANCH    default: main
#   R2_BUCKET       default: proton-pulse-data
#   DATA_BASE       default: https://data.proton-pulse.com
#   SKIP_R2_SYNC    set to 1 to deploy the shell only (Pages half; for testing)

OUTPUT_DIR="${1:?output_dir required (pipeline output with data/ + *.json)}"
REPO_DIR="${2:?repo_dir required (repo checkout with the manifest)}"

PAGES_PROJECT="${PAGES_PROJECT:-proton-pulse-web}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"
R2_BUCKET="${R2_BUCKET:-proton-pulse-data}"
DATA_BASE="${DATA_BASE:-https://data.proton-pulse.com}"

# Top-level data files that ship WITH the shell on Pages (everything the site
# fetches by a bare name, i.e. not under data/). Mirrors the gh-pages deploy's
# optional-file list. data/ is deliberately excluded -- it goes to R2.
SMALL_DATA=(
  search-index.json search-index-steam-extended.json most_played.json
  recent-reports.json stats.json coverage-summary.json data-versions.json
  game-images.json game-images-skip.json deck-status.json proton-versions.json
  steam-catalog.json hardware-suggestions.json scoring-info.json form-schema.json
  app-id-redirects.json
)

log() { echo "[publish-cloudflare] $*"; }

# --- 1. Sync data/ to R2 (S3 API; only changed objects are uploaded) ----------
if [ "${SKIP_R2_SYNC:-0}" = "1" ]; then
  log "SKIP_R2_SYNC=1 -- skipping data/ sync to R2"
elif [ -d "$OUTPUT_DIR/data" ]; then
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required for R2 sync}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required for R2 sync}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required for R2 sync}"
  local_count=$(find "$OUTPUT_DIR/data" -type f | wc -l)
  log "syncing $local_count files from $OUTPUT_DIR/data to r2://$R2_BUCKET/data ..."
  sync_start=$(date +%s)
  # Verbose progress: aws prints one "upload:/delete:" line per changed object.
  # The first migration uploads ~187k objects, so we summarize every 2000 lines
  # (plus a final total) instead of the quiet --only-show-errors, so the log
  # shows the sync steadily advancing. stdbuf keeps awk line-buffered for
  # real-time output; pipefail (set at top) still propagates an aws failure.
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="auto" \
  aws s3 sync "$OUTPUT_DIR/data" "s3://$R2_BUCKET/data" \
    --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --content-type application/json \
    --exclude "*.html" \
    --no-progress \
    | stdbuf -oL awk -v total="$local_count" '
        { c++ }
        c % 2000 == 0 { printf "[publish-cloudflare]   synced %d objects (~%d%% of %d)...\n", c, (total>0 ? c*100/total : 0), total }
        END { printf "[publish-cloudflare]   done: %d objects changed (uploaded/deleted)\n", c }
      '
  sync_end=$(date +%s)
  log "R2 sync complete in $((sync_end - sync_start))s"
else
  log "WARNING: $OUTPUT_DIR/data not found -- skipping R2 sync"
fi

# --- 2. Assemble the Pages deploy directory -----------------------------------
DEPLOY="$(mktemp -d)"
trap 'rm -rf "$DEPLOY"' EXIT

# 2a. Shell: every source file listed in the manifest.
manifest="$REPO_DIR/gh-pages-manifest.txt"
[ -f "$manifest" ] || { log "ERROR: manifest not found at $manifest"; exit 1; }
shell_count=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  case "$p" in \#*) continue ;; esac
  if [ -f "$REPO_DIR/$p" ]; then
    mkdir -p "$DEPLOY/$(dirname "$p")"
    cp "$REPO_DIR/$p" "$DEPLOY/$p"
    shell_count=$((shell_count + 1))
  fi
done < "$manifest"
log "copied $shell_count shell files from the manifest"

# 2b. Small top-level data files from the pipeline output.
for f in "${SMALL_DATA[@]}"; do
  [ -f "$OUTPUT_DIR/$f" ] && cp "$OUTPUT_DIR/$f" "$DEPLOY/$f"
done
# scoring-info + form-schema come from the plugin repo in the gh-pages deploy;
# copy them if the pipeline placed them in the output dir (already covered above).

# 2c. The dual-target routing config: data/ served from R2 on Cloudflare.
printf '{"dataBase":"%s","target":"cloudflare"}\n' "$DATA_BASE" > "$DEPLOY/data-config.json"

# 2d. version.json for the About page (version from package.json, sha from git).
VERSION="$(node -e "console.log(require('$REPO_DIR/package.json').version)" 2>/dev/null || echo 0.0.0)"
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{"version":"%s","sha":"%s","deployed_at":"%s","repo":"mdeguzis/proton-pulse-web","target":"cloudflare"}\n' \
  "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY/version.json"

log "assembled $(find "$DEPLOY" -type f | wc -l) files for Pages (v$VERSION - $SHA)"

# --- 3. Deploy the shell to Cloudflare Pages ----------------------------------
# In CI, CLOUDFLARE_API_TOKEN authenticates wrangler. Locally, wrangler falls
# back to the ambient OAuth login, so a missing token here is only a warning.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  log "WARNING: CLOUDFLARE_API_TOKEN not set -- relying on ambient wrangler auth (OAuth)"
fi
log "deploying to Pages project '$PAGES_PROJECT' (branch $PAGES_BRANCH) ..."
npx wrangler pages deploy "$DEPLOY" \
  --project-name "$PAGES_PROJECT" \
  --branch "$PAGES_BRANCH" \
  --commit-dirty=true

log "done"
