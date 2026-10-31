#!/usr/bin/env bash
set -uo pipefail

# Secrets canary: proves every remaining secret-backed integration still
# authenticates, with one read-only call each (#383, #384). Companion to
# r2-canary.sh (R2 keys) and supabase-canary.sh (Supabase keys + token).
#
#   CLOUDFLARE_API_TOKEN   reads the Pages project (the scope deploys need);
#                          a bogus token must be refused
#   DISCORD_*WEBHOOK*      GET on each webhook URL returns the webhook (posts
#                          nothing). The body holds the webhook token, so it
#                          is never printed.
#   STEAM_API_KEY          ISteamWebAPIUtil/GetSupportedAPIList answers 200
#   SGDB_API_KEY           SteamGridDB game lookup answers 200
#   STAGING_DEPLOY_TOKEN   can read mdeguzis/proton-pulse-web-staging
#   BACKUP_REPO_TOKEN      can read mdeguzis/proton-pulse-data-backup
#   OPENAI_API_KEY, VT_API_KEY   optional integrations, checked when set
#
# With REQUIRE_ALL=1 (CI) a missing required secret is a failure, since a
# deleted secret is exactly what this exists to catch. Locally they skip.
# No response body or secret value is ever printed.
# Exit: 0 = healthy; 1 = a check failed.

overall=0
pass() { echo "  [ok]   $1"; }
fail() { echo "  [FAIL] $1"; overall=1; }
missing() {
  if [ "${REQUIRE_ALL:-0}" = 1 ]; then fail "$1 is not set"; else echo "  [skip] $1 unset"; fi
}
# HTTP status of a GET; extra args are curl headers. Body discarded.
status() { local url="$1"; shift; curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" "$url" || echo 000; }

echo "== Secrets canary =="

# Cloudflare API token (wrangler pages deploy)
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PAGES_PROJECT:-proton-pulse-web}"
  code=$(status "$url" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
  [ "$code" = 200 ] && pass "CLOUDFLARE_API_TOKEN reads the Pages project" \
    || fail "CLOUDFLARE_API_TOKEN got HTTP $code reading the Pages project (expected 200)"
  code=$(status "$url" -H "Authorization: Bearer canary-bogus-token")
  case "$code" in 400|401|403) pass "bogus Cloudflare token refused (HTTP $code)" ;;
    *) fail "bogus Cloudflare token got HTTP $code (expected 400/401/403)" ;; esac
else
  missing "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID"
fi

# Discord webhooks: GET returns the webhook object without posting.
for name in DISCORD_WEBHOOK_BUILDS DISCORD_WEBHOOK_BACKUPS DISCORD_WEBHOOK_ISSUES \
            DISCORD_WEBHOOK_PULL_REQUESTS DISCORD_WEBHOOK_RELEASES DISCORD_ANNOUNCE_WEBHOOK; do
  url="${!name:-}"
  if [ -z "$url" ]; then missing "$name"; continue; fi
  case "$url" in
    https://discord.com/api/webhooks/*) ;;
    *) fail "$name is not a https://discord.com/api/webhooks/ URL"; continue ;;
  esac
  code=$(status "$url")
  [ "$code" = 200 ] && pass "$name answers (HTTP 200)" \
    || fail "$name got HTTP $code (expected 200; deleted or rotated webhook?)"
done

# Steam Web API key. The key rides in the query string, so the URL is never logged.
if [ -n "${STEAM_API_KEY:-}" ]; then
  code=$(status "https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v1/?key=${STEAM_API_KEY}")
  [ "$code" = 200 ] && pass "STEAM_API_KEY accepted" \
    || fail "STEAM_API_KEY got HTTP $code (expected 200)"
else
  missing "STEAM_API_KEY"
fi

# SteamGridDB (box art enrichment)
if [ -n "${SGDB_API_KEY:-}" ]; then
  code=$(status "https://www.steamgriddb.com/api/v2/games/steam/570" -H "Authorization: Bearer $SGDB_API_KEY")
  [ "$code" = 200 ] && pass "SGDB_API_KEY accepted" \
    || fail "SGDB_API_KEY got HTTP $code (expected 200)"
else
  missing "SGDB_API_KEY"
fi

# GitHub PATs used by the staging sync and the backup export. Reading the
# repo proves the token is alive and scoped to it; write access can't be
# checked without writing.
gh_repo_check() {
  local name="$1" repo="$2" token="${!1:-}"
  if [ -z "$token" ]; then missing "$name"; return; fi
  local code
  code=$(status "https://api.github.com/repos/$repo" -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json")
  [ "$code" = 200 ] && pass "$name reads $repo" \
    || fail "$name got HTTP $code reading $repo (expired PAT?)"
}
gh_repo_check STAGING_DEPLOY_TOKEN mdeguzis/proton-pulse-web-staging
gh_repo_check BACKUP_REPO_TOKEN mdeguzis/proton-pulse-data-backup

# Optional integrations: the workflows degrade without them, so unset is fine.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  code=$(status "https://api.openai.com/v1/models" -H "Authorization: Bearer $OPENAI_API_KEY")
  [ "$code" = 200 ] && pass "OPENAI_API_KEY accepted" || fail "OPENAI_API_KEY got HTTP $code (expected 200)"
else
  echo "  [skip] OPENAI_API_KEY unset (optional)"
fi
if [ -n "${VT_API_KEY:-}" ]; then
  code=$(status "https://www.virustotal.com/api/v3/domains/proton-pulse.com" -H "x-apikey: $VT_API_KEY")
  [ "$code" = 200 ] && pass "VT_API_KEY accepted" || fail "VT_API_KEY got HTTP $code (expected 200)"
else
  echo "  [skip] VT_API_KEY unset (optional)"
fi

echo
if [ "$overall" = 0 ]; then
  echo "Secrets canary: healthy."
else
  echo "Secrets canary: FAILURE. See failed checks above." >&2
fi
exit "$overall"
