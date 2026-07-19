#!/usr/bin/env bash
# renew-github-pages-cert.sh
#
# Walks through the GitHub Pages Let's Encrypt cert renewal after ACME
# authorization enters the `bad_authz` state -- which happens when
# Cloudflare's proxy sits in front of the CNAME target and eats the
# HTTP-01 challenge on `/.well-known/acme-challenge/*`. Sequence:
#
#   1. Read current cert state via `gh api repos/.../pages`.
#   2. If already valid + not near expiry: exit 0 with a summary.
#   3. Otherwise print the exact Cloudflare-side steps the operator must
#      take by hand (Cloudflare dashboard changes are not automatable
#      without a CF API token we do not have).
#   4. Wait for the operator to confirm they finished step 3.
#   5. Poll the GitHub Pages API every 30s for up to CERT_RENEW_TIMEOUT
#      until https_certificate.state == 'approved'.
#   6. Once approved, PUT https_enforced=true so redirects come back.
#
# Env vars:
#   REPO              default mdeguzis/proton-pulse-web
#   CERT_RENEW_TIMEOUT   default 900 (seconds, 15 min)
#   POLL_INTERVAL     default 30 (seconds)

set -euo pipefail

REPO=${REPO:-mdeguzis/proton-pulse-web}
CERT_RENEW_TIMEOUT=${CERT_RENEW_TIMEOUT:-900}
POLL_INTERVAL=${POLL_INTERVAL:-30}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 not on PATH" >&2
    exit 1
  }
}
require gh
require python3

api_get_pages() {
  gh api "repos/${REPO}/pages" 2>/dev/null
}

cert_state() {
  python3 -c '
import json, sys
p = json.load(sys.stdin)
cert = p.get("https_certificate") or {}
print(json.dumps({
    "state":       cert.get("state") or "unknown",
    "expires_at":  cert.get("expires_at") or "",
    "description": cert.get("description") or "",
    "domains":     cert.get("domains") or [],
    "https_enforced": p.get("https_enforced"),
    "cname":       p.get("cname") or "",
}))
'
}

echo "=== GitHub Pages certificate state for ${REPO} ==="
CURRENT=$(api_get_pages | cert_state)
echo "${CURRENT}" | python3 -m json.tool

STATE=$(echo "${CURRENT}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
CNAME=$(echo "${CURRENT}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cname"])')

if [ "${STATE}" = "approved" ]; then
  echo ""
  echo "Certificate is currently approved. Ensuring https_enforced=true..."
  gh api -X PUT "repos/${REPO}/pages" --input <(echo '{"https_enforced": true}') >/dev/null
  echo "Done."
  exit 0
fi

cat <<'EOF'

The cert is NOT in the "approved" state. Most common cause on this
repo: Cloudflare's proxy sits in front of the CNAME and intercepts
the HTTP-01 ACME challenge Let's Encrypt uses to verify domain
ownership. This script cannot flip Cloudflare's cloud icon for you --
that has to happen in the Cloudflare dashboard.

STEPS TO TAKE NOW (on the Cloudflare side):

  1. Log in to https://dash.cloudflare.com/
  2. Select the proton-pulse.com zone
  3. Open DNS -> Records
  4. Find the record whose Name points at the GitHub Pages CNAME
     (usually "www" and the root "@"). For this repo the CNAME is:
EOF
echo "         ${CNAME}"
cat <<'EOF'
  5. Click the orange cloud icon on EACH of those records so it turns
     grey ("DNS only"). This disables the proxy temporarily so
     Let's Encrypt can talk to GitHub Pages directly.
  6. Wait about 30-60 seconds for DNS propagation.
  7. Come back here and press ENTER to start polling the GitHub Pages
     API for the new cert.

  After we finish, you will:
  8. Re-enable the orange cloud (proxy back on) in Cloudflare.
  9. Under SSL/TLS -> Overview, set the encryption mode to "Full"
     (NOT "Full (strict)") so GH Pages' Let's Encrypt cert is
     accepted long-term.

EOF

read -r -p "Press ENTER once the Cloudflare records are grey-clouded... "

DEADLINE=$(( $(date +%s) + CERT_RENEW_TIMEOUT ))
echo ""
echo "Polling repos/${REPO}/pages every ${POLL_INTERVAL}s until certificate state = approved (or ${CERT_RENEW_TIMEOUT}s elapse)..."
while true; do
  CURRENT=$(api_get_pages | cert_state)
  STATE=$(echo "${CURRENT}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
  DESC=$(echo "${CURRENT}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("description",""))')
  NOW=$(date +%s)
  echo "$(date -u +%H:%M:%S) state=${STATE} description=${DESC}"
  if [ "${STATE}" = "approved" ]; then
    echo ""
    echo "Certificate provisioned. Enforcing HTTPS..."
    gh api -X PUT "repos/${REPO}/pages" --input <(echo '{"https_enforced": true}') >/dev/null
    echo "Done. Re-enable the Cloudflare proxy (orange cloud) and set SSL/TLS mode to 'Full'."
    exit 0
  fi
  if [ "${NOW}" -ge "${DEADLINE}" ]; then
    echo ""
    echo "Timed out after ${CERT_RENEW_TIMEOUT}s. Cert state is still ${STATE}."
    echo "  - If state is still bad_authz: give Cloudflare + DNS another minute, then re-run this script."
    echo "  - If state is unavailable / pending: check GitHub Pages settings in the browser."
    exit 1
  fi
  sleep "${POLL_INTERVAL}"
done
