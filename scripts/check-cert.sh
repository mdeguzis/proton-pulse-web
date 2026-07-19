#!/usr/bin/env bash
set -euo pipefail

# Human-readable cert diagnostic for the live site (#359). Runs the monitor
# probe against a temp file (does NOT touch gh-pages) and prints edge cert,
# origin cert, and GitHub's Pages ACME state. Use it any time you want to know
# why the origin cert is in whatever state it is.
#
# Usage: make check-cert   (or: bash scripts/check-cert.sh)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Use a GitHub token if one is available locally so the Pages state comes back
# (gh CLI first, then GITHUB_TOKEN). Without it the origin/edge certs still
# print; only the GitHub ACME state is skipped.
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi

GITHUB_TOKEN="$TOKEN" bash "$REPO_ROOT/scripts/cert-monitor.sh" "$TMP/cert-status.json" "$TMP/cert-history.json" >/dev/null

NOW_EPOCH="$(date -u +%s)"

# Print one cert block with blank-line spacing and a computed VALID/EXPIRED line.
print_cert() {
  local title="$1" note="$2" json="$3"
  echo "  $title"
  if [ "$(echo "$json" | jq -r 'type')" != "object" ]; then
    echo "    Status: UNREACHABLE (could not read this cert)"
    echo ""
    return
  fi
  local issuer nb na na_epoch status
  issuer="$(echo "$json" | jq -r '.issuer // "?"' | sed -E 's/.*O=([^,]+).*CN=([^,]+).*/\1 (\2)/')"
  nb="$(echo "$json" | jq -r '(.not_before // "?")[0:10]')"
  na="$(echo "$json" | jq -r '(.not_after // "?")[0:10]')"
  na_epoch="$(date -u -d "$(echo "$json" | jq -r '.not_after // ""')" +%s 2>/dev/null || echo 0)"
  if [ "$na_epoch" -gt 0 ] && [ "$na_epoch" -lt "$NOW_EPOCH" ]; then
    status="EXPIRED"
  else
    local days=$(( (na_epoch - NOW_EPOCH) / 86400 ))
    status="VALID ($days days left)"
  fi
  echo "    Issuer: $issuer"
  echo "    Valid:  $nb  ->  $na"
  echo "    Status: $status"
  [ -n "$note" ] && echo "    $note"
  echo ""
}

echo ""
echo "TLS certificate check -- $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================"
echo ""
echo "Domain: $(jq -r '.domain' "$TMP/cert-status.json")"
echo ""
print_cert "Edge cert   (what browsers see, via Cloudflare)"  "Auto-renewed by Cloudflare." "$(jq -c '.edge' "$TMP/cert-status.json")"
print_cert "Origin cert (GitHub Pages backend, behind CF)"    ""                           "$(jq -c '.origin' "$TMP/cert-status.json")"

gh_state="$(jq -r 'if (.github_pages|type)=="object" then .github_pages.state else "" end' "$TMP/cert-status.json")"
if [ -n "$gh_state" ]; then
  gh_desc="$(jq -r '.github_pages.description // ""' "$TMP/cert-status.json")"
  echo "  GitHub Pages ACME state: $gh_state"
  echo "    $gh_desc"
  echo ""
fi

echo "============================================================"
echo "Note: browsers only ever see the EDGE cert. An expired ORIGIN"
echo "cert only causes an outage (Cloudflare 526) when SSL mode is"
echo "Full (strict). Full picture + renewal steps:"
echo "  https://github.com/mdeguzis/proton-pulse-web/wiki/GitHub-Pages-Cert-Renewal"
echo ""
