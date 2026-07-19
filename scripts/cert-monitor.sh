#!/usr/bin/env bash
set -euo pipefail

# Monitor the TLS certificates for the live site (#359). Called by
# .github/workflows/cert-monitor.yml (and by `make check-cert`).
#
# There are TWO certs in play for a GitHub-Pages-behind-Cloudflare site, and
# both matter:
#
#   edge   -- the cert Cloudflare serves to browsers. Cloudflare auto-renews it.
#             This is what a visitor validates.
#   origin -- the cert GitHub Pages serves on its backend, behind Cloudflare.
#             When Cloudflare's SSL mode is Full (strict) it validates THIS cert,
#             so if it expires visitors get a 526. It does NOT auto-renew while
#             the domain is proxied (orange cloud), because GitHub's Let's
#             Encrypt HTTP-01 challenge cannot reach GitHub through the proxy --
#             GitHub parks in state "bad_authz".
#
# We also pull GitHub's own view of the Pages cert (state + description) so the
# status page can explain WHY the origin cert is stale (e.g. bad_authz), not
# just that it is. That read uses the Actions GITHUB_TOKEN -- the built-in token
# can read its own repo's Pages info, so there is still no PAT to manage.
#
# Output (written into the gh-pages checkout):
#   cert-status.json  -- { edge, origin, github_pages, ... } latest snapshot
#   cert-history.json -- append-only points for the burndown (origin + edge)
#
# Bucket / state math lives in js/lib/cert.js so the frontend and tests share
# one definition; this script only records raw facts.

OUT_STATUS="${1:?path to cert-status.json required}"
OUT_HISTORY="${2:?path to cert-history.json required}"

DOMAIN="${CERT_DOMAIN:-www.proton-pulse.com}"
REPO="${CERT_REPO:-mdeguzis/proton-pulse-web}"
# GitHub Pages apex anycast IPs -- the origin we read the backend cert from.
PAGES_IPS=(185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153)
MAX_HISTORY="${CERT_MAX_HISTORY:-400}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

to_iso() {
  local raw="$1"
  [ -n "$raw" ] || { echo ""; return; }
  date -u -d "$raw" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo ""
}

# Turn a PEM on stdin into a compact JSON cert object, or "null" if empty.
pem_to_json() {
  local pem; pem="$(cat)"
  [ -n "$pem" ] || { echo "null"; return; }
  local subject issuer nb na san
  subject="$(echo "$pem" | openssl x509 -noout -subject 2>/dev/null | sed 's/^subject=//; s/^ *//')"
  issuer="$(echo "$pem" | openssl x509 -noout -issuer 2>/dev/null | sed 's/^issuer=//; s/^ *//')"
  nb="$(to_iso "$(echo "$pem" | openssl x509 -noout -startdate 2>/dev/null | sed 's/^notBefore=//')")"
  na="$(to_iso "$(echo "$pem" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')")"
  san="$(echo "$pem" | openssl x509 -noout -ext subjectAltName 2>/dev/null \
    | grep -oE 'DNS:[^,]+' | sed 's/^DNS://; s/ *$//' | jq -R . | jq -s . 2>/dev/null || echo '[]')"
  [ -n "$san" ] || san='[]'
  [ -n "$na" ] || { echo "null"; return; }
  jq -n --arg subject "$subject" --arg issuer "$issuer" --argjson san "$san" \
    --arg not_before "$nb" --arg not_after "$na" \
    '{reachable: true, subject: $subject, issuer: $issuer, san: $san, not_before: $not_before, not_after: $not_after}'
}

# --- edge cert: connect to the domain the normal way (through Cloudflare) ---
edge_json="$(echo | timeout 20 openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
  | openssl x509 2>/dev/null | pem_to_json || echo 'null')"
[ -n "$edge_json" ] || edge_json='null'

# --- origin cert: connect to a GitHub Pages IP with SNI, first SAN match wins ---
origin_json='null'
for ip in "${PAGES_IPS[@]}"; do
  pem="$(echo | timeout 15 openssl s_client -servername "$DOMAIN" -connect "$ip:443" 2>/dev/null | openssl x509 2>/dev/null || true)"
  [ -n "$pem" ] || continue
  if echo "$pem" | openssl x509 -noout -ext subjectAltName 2>/dev/null | grep -qF "$DOMAIN"; then
    origin_json="$(echo "$pem" | pem_to_json)"
    break
  fi
done

# --- GitHub Pages cert state (best-effort; explains WHY origin is stale) ---
gh_json='null'
if [ -n "${GITHUB_TOKEN:-}" ]; then
  gh_json="$(curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/pages" 2>/dev/null \
    | jq -c '.https_certificate | if . == null then null else {state: .state, description: .description, expires_at: .expires_at} end' 2>/dev/null || echo 'null')"
  [ -n "$gh_json" ] || gh_json='null'
fi

jq -n \
  --arg domain "$DOMAIN" \
  --arg checked_at "$CHECKED_AT" \
  --argjson edge "$edge_json" \
  --argjson origin "$origin_json" \
  --argjson github_pages "$gh_json" \
  '{ok: true, domain: $domain, checked_at: $checked_at, edge: $edge, origin: $origin, github_pages: $github_pages}' \
  > "$OUT_STATUS"

# --- history: one point per run, carrying both certs'\'' expiry for the burndown ---
origin_na="$(echo "$origin_json" | jq -r 'if type=="object" then .not_after else "" end')"
edge_na="$(echo "$edge_json" | jq -r 'if type=="object" then .not_after else "" end')"

existing='[]'
if [ -f "$OUT_HISTORY" ]; then
  existing="$(jq -c '.' "$OUT_HISTORY" 2>/dev/null || echo '[]')"
  case "$existing" in \[*) : ;; *) existing='[]' ;; esac
fi
echo "$existing" | jq \
  --arg checked_at "$CHECKED_AT" \
  --arg origin_not_after "$origin_na" \
  --arg edge_not_after "$edge_na" \
  --argjson max "$MAX_HISTORY" \
  '. + [{checked_at: $checked_at, origin_not_after: ($origin_not_after|select(length>0)), edge_not_after: ($edge_not_after|select(length>0))}] | .[-$max:]' \
  > "$OUT_HISTORY"

echo "wrote $OUT_STATUS"
echo "  edge   not_after: $(echo "$edge_json"   | jq -r 'if type=="object" then .not_after else "unreachable" end')"
echo "  origin not_after: $(echo "$origin_json" | jq -r 'if type=="object" then .not_after else "unreachable" end')"
echo "  github pages    : $(echo "$gh_json"     | jq -r 'if type=="object" then "\(.state) (\(.description))" else "n/a (no token)" end')"
