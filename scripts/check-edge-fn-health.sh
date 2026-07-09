#!/usr/bin/env bash
set -euo pipefail

# Ping every Supabase edge function this site uses and write the result
# to edge-status.json (#254). Called by .github/workflows/edge-fn-health.yml.
#
# The check is an OPTIONS request (CORS preflight) with an origin + apikey
# header. Every deployed edge fn should respond 204 fast (~100ms). 5xx is
# treated as down. Non-2xx / non-204 becomes degraded. Any timeout / connection
# failure is also down.

: "${SUPABASE_URL:?SUPABASE_URL required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY required}"

OUT_FILE="${1:-edge-status.json}"

FNS=(
  image-refetch
  plugin-link-complete
  plugin-link-remove
  plugin-link-start
  plugin-link-status
  plugin-link-unlink
  plugin-links-list
  protondb-summary
  steam-appdetails
  steam-callback
  steam-depot-info
  steam-explore
  steam-library-lookup
  steam-news
  sync-steam-library
  user-system-upload
)

services='[]'
for fn in "${FNS[@]}"; do
  start=$(date +%s%3N)
  http_code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
    -H "Origin: https://www.proton-pulse.com" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization, content-type" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    --max-time 15 \
    "$SUPABASE_URL/functions/v1/$fn" || echo "000")
  end=$(date +%s%3N)
  latency_ms=$((end - start))

  case "$http_code" in
    200|204)      status="operational" ;;
    5[0-9][0-9])  status="down" ;;
    000)          status="down" ;;
    *)            status="degraded" ;;
  esac

  service=$(jq -n \
    --arg name "$fn" \
    --arg status "$status" \
    --argjson http_status "$http_code" \
    --argjson latency_ms "$latency_ms" \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{name: $name, status: $status, http_status: $http_status, latency_ms: $latency_ms, checked_at: $checked_at}')
  services=$(echo "$services" | jq --argjson s "$service" '. + [$s]')
  echo "  [$status] $fn HTTP $http_code (${latency_ms}ms)"
done

# Aggregate: any down -> down; else any degraded -> degraded; else operational.
overall=$(echo "$services" | jq -r 'if any(.[]; .status == "down") then "down" elif any(.[]; .status == "degraded") then "degraded" else "operational" end')

jq -n \
  --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg overall "$overall" \
  --arg run_url "${RUN_URL:-}" \
  --argjson services "$services" \
  '{updated_at: $updated_at, overall: $overall, run_url: $run_url, services: $services}' > "$OUT_FILE"

echo "wrote $OUT_FILE (overall: $overall)"
