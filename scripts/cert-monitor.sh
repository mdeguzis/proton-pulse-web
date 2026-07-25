#!/usr/bin/env bash
set -euo pipefail

# Monitor the TLS certificate for the live site (#359). Called by
# .github/workflows/cert-monitor.yml (and by `make check-cert`).
#
# Post-#362 the site is fully served from Cloudflare Pages, so there is now
# exactly ONE cert in play: the one Cloudflare serves to browsers. Cloudflare
# auto-renews it. There is no separate origin cert because CF Pages IS the
# origin -- no GitHub-Pages-behind-Cloudflare hop, no bad_authz saga.
#
# Output (written into the gh-pages checkout for the frontend to fetch):
#   cert-status.json  -- { edge, ... } latest snapshot. The `origin` and
#                        `github_pages` fields are intentionally omitted; the
#                        frontend treats their absence as "single-cert model".
#   cert-history.json -- append-only points for the burndown (edge only).
#
# Bucket / state math lives in js/lib/cert.js so the frontend and tests share
# one definition; this script only records raw facts.

OUT_STATUS="${1:?path to cert-status.json required}"
OUT_HISTORY="${2:?path to cert-history.json required}"

DOMAIN="${CERT_DOMAIN:-www.proton-pulse.com}"
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

jq -n \
  --arg domain "$DOMAIN" \
  --arg checked_at "$CHECKED_AT" \
  --argjson edge "$edge_json" \
  '{ok: true, domain: $domain, checked_at: $checked_at, edge: $edge}' \
  > "$OUT_STATUS"

# --- history: one point per run, edge cert expiry for the burndown ---
edge_na="$(echo "$edge_json" | jq -r 'if type=="object" then .not_after else "" end')"

existing='[]'
if [ -f "$OUT_HISTORY" ]; then
  existing="$(jq -c '.' "$OUT_HISTORY" 2>/dev/null || echo '[]')"
  case "$existing" in \[*) : ;; *) existing='[]' ;; esac
fi
echo "$existing" | jq \
  --arg checked_at "$CHECKED_AT" \
  --arg edge_not_after "$edge_na" \
  --argjson max "$MAX_HISTORY" \
  '. + [{checked_at: $checked_at, edge_not_after: ($edge_not_after|select(length>0))}] | .[-$max:]' \
  > "$OUT_HISTORY"

echo "wrote $OUT_STATUS"
echo "  edge not_after: $(echo "$edge_json" | jq -r 'if type=="object" then .not_after else "unreachable" end')"
