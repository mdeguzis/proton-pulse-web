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
  app-id-redirects.json pcgamingwiki.json pcgwiki-catalog.json
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
  # Concurrency + adaptive retry so an R2 per-object ServiceUnavailable does not
  # fail the whole run (#379). Key point: R2's ~1/sec write limit is PER OBJECT
  # KEY (the same file written repeatedly), NOT a cap across distinct keys. We
  # write ~187k DISTINCT keys, so that limit does not apply to fan-out -- higher
  # concurrency is safe. This was pinned to 4 as an over-correction to the #379
  # transient errors, made before the outer retry loop below existed to catch
  # them. With that loop + `adaptive` backoff (exponential + jitter, inspects
  # throttling metadata) as backstops, run wide: 4 concurrent PUTs made a full
  # ~187k sync crawl for ~40 min. Tunable via R2_SYNC_CONCURRENCY (workflow env)
  # without a code change, so we can dial back instantly if R2 pushes back.
  aws configure set default.s3.max_concurrent_requests "${R2_SYNC_CONCURRENCY:-32}"

  # One `aws s3 sync` pass. Verbose progress: aws prints one line per changed
  # object; awk summarizes every 2000 (stdbuf keeps it line-buffered for
  # real-time output). pipefail (set at top) propagates an aws failure through
  # the awk pipe, so the `if` in the loop below sees it.
  sync_pass() {
    local pass="$1"
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="auto" \
    AWS_MAX_ATTEMPTS=10 \
    AWS_RETRY_MODE=adaptive \
    aws s3 sync "$OUTPUT_DIR/data" "s3://$R2_BUCKET/data" \
      --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --content-type application/json \
      --exclude "*.html" \
      --no-progress \
      | stdbuf -oL awk -v total="$local_count" -v pass="$pass" '
          { c++ }
          c % 2000 == 0 { printf "[publish-cloudflare]   pass %d: synced %d objects (~%d%% of %d)...\n", pass, c, (total>0 ? c*100/total : 0), total }
          END { printf "[publish-cloudflare]   pass %d: %d objects changed this pass\n", pass, c }
        '
  }

  # aws s3 sync is incremental, so re-running after a transient failure RESUMES
  # (already-uploaded objects are skipped). A single ~187k-object sync against
  # R2 occasionally trips a transient error that exhausts even adaptive retry and
  # fails the whole pass at a random point (43%, 82%, ...). Wrap it in an outer
  # retry loop: each pass uploads fewer objects until one completes cleanly, so
  # a mid-sync R2 hiccup self-heals instead of failing the deploy. NOTE: this
  # does NOT paper over a real permission error (e.g. AccessDenied on the bucket)
  # -- that fails every pass instantly and the loop still exits non-zero.
  MAX_SYNC_PASSES="${MAX_SYNC_PASSES:-8}"
  sync_ok=0
  for pass in $(seq 1 "$MAX_SYNC_PASSES"); do
    log "R2 sync pass $pass/$MAX_SYNC_PASSES to r2://$R2_BUCKET/data ..."
    if sync_pass "$pass"; then
      sync_ok=1
      break
    fi
    log "R2 sync pass $pass failed (likely transient); re-running to resume from where it stopped"
    sleep $((pass * 15))
  done
  sync_end=$(date +%s)
  if [ "$sync_ok" = 1 ]; then
    log "R2 sync complete in $((sync_end - sync_start))s ($pass pass(es))"
  else
    log "ERROR: R2 sync to r2://$R2_BUCKET/data failed after $MAX_SYNC_PASSES passes (check bucket perms if it failed instantly with 0 objects)"
    exit 1
  fi
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

# 2b.i. Preserve cert-monitor output across the CF Pages deploy. cert-monitor.yml
# writes cert-status.json + cert-history.json to gh-pages every 6h. Those files
# are read same-origin by the status page, so on CF Pages they need to ride the
# shell deploy. Copy the latest from origin/gh-pages (best-effort: if the fetch
# fails or the files do not exist yet, the status page shows the "not run yet"
# empty state instead of erroring). Same preserve pattern gh-pages uses via
# scripts/preserve-cert-monitor.sh.
if [ -x "$REPO_DIR/scripts/preserve-cert-monitor.sh" ]; then
  bash "$REPO_DIR/scripts/preserve-cert-monitor.sh" "$DEPLOY" || \
    log "cert-monitor preserve step warned; continuing"
fi

# 2c. The dual-target routing config: data/ served from R2 on Cloudflare.
printf '{"dataBase":"%s","target":"cloudflare"}\n' "$DATA_BASE" > "$DEPLOY/data-config.json"

# 2d. version.json for the About page (version from package.json, sha from git).
VERSION="$(node -e "console.log(require('$REPO_DIR/package.json').version)" 2>/dev/null || echo 0.0.0)"
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '{"version":"%s","sha":"%s","deployed_at":"%s","repo":"mdeguzis/proton-pulse-web","target":"cloudflare"}\n' \
  "$VERSION" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY/version.json"

log "assembled $(find "$DEPLOY" -type f | wc -l) files for Pages (v$VERSION - $SHA)"

# --- 2e. Refuse to deploy an older commit on top of a newer one ---------------
# Two workflows can deploy to the same CF Pages project: this script (called
# from publish-shell.yml on every push) and update-data.yml's finalize job
# (called from `make gh-run` / cron / gh-staging-*). They share a concurrency
# group so they cannot run in parallel, but a slow pipeline that STARTED
# with an old checkout can still finish after a fresh shell push has already
# landed -- and would happily overwrite it. This guard is the second safety
# net: compare our git commit time to the deployed_at on the live target,
# and skip the wrangler deploy if we would move the site BACKWARDS.
#
# The check is best-effort. Failures to reach the live version.json (first
# deploy, DNS blip, curl not present) fall through and let the deploy run
# -- we would rather ship than deadlock.
LIVE_DOMAIN=""
case "$PAGES_PROJECT" in
  proton-pulse-web-staging) LIVE_DOMAIN="staging.proton-pulse.com" ;;
  proton-pulse-web)         LIVE_DOMAIN="www.proton-pulse.com" ;;
esac
if [ -n "$LIVE_DOMAIN" ] && command -v curl >/dev/null 2>&1; then
  live_json="$(curl -sf --max-time 10 "https://$LIVE_DOMAIN/version.json" 2>/dev/null || echo '')"
  if [ -n "$live_json" ]; then
    live_deployed_at="$(printf '%s' "$live_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("deployed_at",""))' 2>/dev/null || echo '')"
    live_sha="$(printf '%s' "$live_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))' 2>/dev/null || echo '')"
    # Our commit's ISO timestamp (committer date). git log emits it with the
    # committer's local offset -- e.g. 2026-07-20T21:30:54-04:00 for a commit
    # made in EDT -- so we MUST normalize to actual UTC before comparing,
    # otherwise a lexicographic string compare says "2026-07-20..." <
    # "2026-07-21..." even though the first is really a later moment. Bug
    # note: an earlier version of this check did a naive sed on '+00:00' -> Z
    # which only handled commits already in UTC; that dropped every deploy
    # made from a non-UTC dev box.
    our_commit_iso="$(git -C "$REPO_DIR" log -1 --format=%cI HEAD 2>/dev/null || echo '')"
    if [ -n "$live_deployed_at" ] && [ -n "$our_commit_iso" ]; then
      # date -d "..." -u prints UTC regardless of the input offset. GNU date
      # (Ubuntu runners) accepts full ISO 8601 with offset here. Output
      # format matches deployed_at exactly (Z suffix, no fractional sec).
      our_ts="$(date -d "$our_commit_iso" -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
      if [ -z "$our_ts" ]; then
        log "version guard skipped: could not normalize commit ts '$our_commit_iso' to UTC -- proceeding with deploy"
      elif [ "$our_ts" \< "$live_deployed_at" ]; then
        log "SKIP: current live deploy (sha=$live_sha, deployed_at=$live_deployed_at) is NEWER than our commit ($SHA, $our_ts). Refusing to move the site backwards."
        exit 0
      else
        log "version guard OK: live deployed_at=$live_deployed_at, our commit=$our_ts -- proceeding"
      fi
    fi
  fi
fi

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
