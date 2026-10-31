#!/usr/bin/env bash
set -uo pipefail

# Supabase canary: a fast integration test that the Supabase credentials the
# site + pipeline depend on actually work. Supabase is the ONLY canonical /
# irreplaceable data store (user reports, votes, systems), so a broken key here
# is the scariest secret failure we have -- this catches it in seconds instead
# of when a real login or pipeline write fails. Companion to scripts/r2-canary.sh
# (#382); part of the "every secret gets a canary" effort (#383).
#
# What it proves:
#   1. Anon read path      -- SUPABASE_URL + anon key + a public RLS read return 200.
#   2. Anon is enforced    -- a bogus key returns 401 (so check 1 is not a false pass).
#   3. Anon RPC path       -- a public RPC (author_stats_by_client) returns 200.
#   4. Service-role path   -- (only if SUPABASE_SERVICE_ROLE_KEY is set, i.e. CI)
#                             the service key reads rows from an RLS-protected
#                             table (`admins`) that anon is filtered to [] on.
#                             This proves the service key bypasses RLS -- not just
#                             that it authenticates. Row contents are never printed.
#   5. Management API      -- (only if SUPABASE_TOKEN is set) the access token reads
#                             the project and it reports ACTIVE_HEALTHY, and a bogus
#                             token gets 401. Migrations, edge function deploys and the
#                             encrypted database backup (#580) all run on this token.
#
# Env:
#   SUPABASE_URL              (optional locally -- falls back to the value shipped
#   SUPABASE_ANON_KEY          in js/lib/supabase-client.js, both public)
#   SUPABASE_SERVICE_ROLE_KEY (optional -- when set, runs check 4; secret, CI only)
#   SUPABASE_TOKEN            (optional -- when set, runs check 5; secret)
#   SUPABASE_PROJECT_REF      (optional -- default: the ref in SUPABASE_URL)
# Exit: 0 = healthy; 1 = a check failed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_JS="$REPO_ROOT/js/lib/supabase-client.js"

# The URL + anon key are public (served to every browser). For local runs, read
# them straight from the client the site ships so there is zero setup and no
# drift -- the canary always tests the key the site is actually using.
if [ -z "${SUPABASE_URL:-}" ] && [ -f "$CLIENT_JS" ]; then
  SUPABASE_URL="$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$CLIENT_JS" | head -1)"
fi
if [ -z "${SUPABASE_ANON_KEY:-}" ] && [ -f "$CLIENT_JS" ]; then
  SUPABASE_ANON_KEY="$(grep -oE 'sb_(publishable|anon)_[A-Za-z0-9_-]+' "$CLIENT_JS" | head -1)"
fi
: "${SUPABASE_URL:?SUPABASE_URL required (env or js/lib/supabase-client.js)}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY required (env or js/lib/supabase-client.js)}"

REST="$SUPABASE_URL/rest/v1"
overall=0
pass() { echo "  [ok]   $1"; }
fail() { echo "  [FAIL] $1"; overall=1; }

echo "== Supabase canary: $SUPABASE_URL =="

# 1. anon read of a public table
code=$(curl -s -o /dev/null -w '%{http_code}' \
  "$REST/author_avatars?select=proton_pulse_user_id&limit=1" -H "apikey: $SUPABASE_ANON_KEY")
[ "$code" = 200 ] && pass "anon read author_avatars (HTTP 200)" \
  || fail "anon read author_avatars returned HTTP $code (expected 200) -- anon key or SUPABASE_URL is bad"

# 2. negative control: a bogus key must NOT be accepted
code=$(curl -s -o /dev/null -w '%{http_code}' \
  "$REST/author_avatars?select=proton_pulse_user_id&limit=1" -H "apikey: sb_publishable_CANARY_BOGUS_KEY")
[ "$code" = 401 ] && pass "bogus key rejected (HTTP 401)" \
  || fail "bogus key returned HTTP $code (expected 401) -- auth is not being enforced"

# 3. anon RPC path
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$REST/rpc/author_stats_by_client" \
  -H "apikey: $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"p_client_id":"supabase-canary-nonexistent"}')
[ "$code" = 200 ] && pass "anon RPC author_stats_by_client (HTTP 200)" \
  || fail "anon RPC returned HTTP $code (expected 200)"

# 4. service-role differential (CI only -- key is secret)
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  # anon must be filtered to [] on the protected table
  anon_body=$(curl -s "$REST/admins?select=proton_pulse_user_id&limit=1" -H "apikey: $SUPABASE_ANON_KEY")
  # service role must see at least one row (never print the rows themselves)
  svc_code=$(curl -s -o /dev/null -w '%{http_code}' "$REST/admins?select=proton_pulse_user_id&limit=1" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
  svc_count=$(curl -s "$REST/admins?select=proton_pulse_user_id&limit=1" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    | grep -o '"proton_pulse_user_id"' | wc -l)
  if [ "$svc_code" = 200 ] && [ "$svc_count" -ge 1 ] && [ "$anon_body" = "[]" ]; then
    pass "service-role bypasses RLS on admins (anon []=filtered, service sees rows)"
  else
    fail "service-role differential failed (svc HTTP $svc_code, svc rows $svc_count, anon body '$anon_body') -- SUPABASE_SERVICE_ROLE_KEY is bad or RLS changed"
  fi
else
  echo "  [skip] service-role check (SUPABASE_SERVICE_ROLE_KEY unset -- runs in CI)"
fi

# 5. Management API token (migrations, deploy-functions, backup-db)
if [ -n "${SUPABASE_TOKEN:-}" ]; then
  REF="${SUPABASE_PROJECT_REF:-$(echo "$SUPABASE_URL" | sed -E 's#https://([a-z0-9]+)\.supabase\.co.*#\1#')}"
  MGMT="https://api.supabase.com/v1/projects/$REF"
  status=$(curl -s "$MGMT" -H "Authorization: Bearer $SUPABASE_TOKEN" \
    | grep -oE '"status":"[A-Z_]+"' | head -1 | cut -d'"' -f4)
  [ "$status" = ACTIVE_HEALTHY ] && pass "Management API token reads project $REF (ACTIVE_HEALTHY)" \
    || fail "Management API token check got status '${status:-none}' (expected ACTIVE_HEALTHY) -- SUPABASE_TOKEN is bad or the project is unhealthy"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$MGMT" -H "Authorization: Bearer sbp_canary_bogus")
  [ "$code" = 401 ] && pass "bogus Management API token rejected (HTTP 401)" \
    || fail "bogus Management API token returned HTTP $code (expected 401)"
else
  echo "  [skip] Management API check (SUPABASE_TOKEN unset)"
fi

echo
if [ "$overall" = 0 ]; then
  echo "Supabase canary: healthy."
else
  echo "Supabase canary: FAILURE. See failed checks above." >&2
fi
exit "$overall"
