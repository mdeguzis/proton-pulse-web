#!/usr/bin/env bash
set -euo pipefail

# Poll GitHub's Security tab APIs for open alerts and print a summary. Runs
# read-only against the current repo's Dependabot, code-scanning (CodeQL /
# semgrep), and secret-scanning alert endpoints. CI-side scans (npm audit,
# CodeQL analyze, semgrep/ci, sbom+grype) fail PRs during the build, but
# alerts that persist in the Security tab -- open Dependabot alerts,
# unresolved CodeQL findings, leaked secrets -- do NOT fail any build and
# only surface if someone loads the tab. This script pulls them so they
# can be reviewed at the start of any security-relevant session and before
# promoting staging -> main.
#
# Called by:
#   - `make security-check` (manual, at any time)
#   - .github/workflows/security-alerts-nightly.yml (cron, posts to Discord)
#
# Exit codes:
#   0 = no open critical or high severity alerts (any open low/medium/info
#       still print in the summary but don't fail; that's a review call, not
#       a stop-work signal)
#   1 = at least one open critical or high severity alert
#   2 = an API call failed (missing token, rate limit, etc.)
#
# Env:
#   GH_REPO      optional; defaults to `gh repo view --json nameWithOwner`
#   SEVERITY_FAIL optional; comma-separated list, default "critical,high"
#   FORMAT       optional; "human" (default) or "json"

: "${GH_REPO:=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)}"
if [[ -z "${GH_REPO}" ]]; then
  echo "ERROR: GH_REPO not set and gh could not infer the current repo." >&2
  exit 2
fi

SEVERITY_FAIL="${SEVERITY_FAIL:-critical,high}"
FORMAT="${FORMAT:-human}"

fetch_alerts() {
  local endpoint="$1"
  # Return the raw JSON array (or "[]" on any error -- endpoints 404 when the
  # feature is disabled on the repo, and we want the script to keep going).
  gh api "repos/${GH_REPO}/${endpoint}?state=open&per_page=100" 2>/dev/null || echo "[]"
}

DEPENDABOT_JSON="$(fetch_alerts dependabot/alerts)"
CODE_SCAN_JSON="$(fetch_alerts code-scanning/alerts)"
SECRET_SCAN_JSON="$(fetch_alerts secret-scanning/alerts)"

# Normalise each source into a common shape: [{source, severity, title,
# location, url, created_at}, ...]
NORMALIZED="$(jq -n \
  --argjson dep "${DEPENDABOT_JSON}" \
  --argjson cs "${CODE_SCAN_JSON}" \
  --argjson ss "${SECRET_SCAN_JSON}" '
  ($dep  | map({
    source: "dependabot",
    severity: (.security_advisory.severity // "unknown"),
    rule_severity: null,
    title:    (.security_advisory.summary  // "(no summary)"),
    location: (.dependency.package.name    // "?"),
    url:      .html_url,
    created_at: .created_at
  })) +
  ($cs   | map({
    source: "code-scanning",
    # security_severity_level (critical/high/medium/low), NOT rule.severity.
    # rule.severity is the ANALYSIS severity -- note/warning/error -- which
    # shares no vocabulary with the fail list, so every code-scanning alert
    # landed in no bucket and the summary read "High: 0" next to a total of 1.
    # A high-severity XSS therefore did not trip the gate built to catch it
    # (alert 60, js/xss-through-dom, issue #502). Rules with no security
    # severity (pure quality rules) keep their analysis severity, which
    # deliberately still matches nothing in the fail list.
    severity: (.rule.security_severity_level // .rule.severity // "unknown"),
    rule_severity: (.rule.severity // "unknown"),
    title:    (.rule.description // .rule.id // "(no description)"),
    location: ((.most_recent_instance.location.path // "?") + ":" + ((.most_recent_instance.location.start_line // 0) | tostring)),
    url:      .html_url,
    created_at: .created_at
  })) +
  ($ss   | map({
    source: "secret-scanning",
    severity: "critical",
    rule_severity: null,
    title:    (.secret_type_display_name // .secret_type // "(secret)"),
    location: ((.locations[0].details.path // "?") + " commit " + ((.locations[0].details.commit_sha // "?") | .[0:7])),
    url:      .html_url,
    created_at: .created_at
  }))
')"

# Count by severity so the summary line + exit code reflect the risk level.
count_sev() { echo "${NORMALIZED}" | jq --arg s "$1" 'map(select(.severity == $s)) | length'; }
CRIT="$(count_sev critical)"
HIGH="$(count_sev high)"
MED="$(count_sev medium)"
LOW="$(count_sev low)"
TOTAL="$(echo "${NORMALIZED}" | jq 'length')"

if [[ "${FORMAT}" == "json" ]]; then
  jq -n \
    --argjson alerts "${NORMALIZED}" \
    --arg repo "${GH_REPO}" \
    --argjson crit "${CRIT}" --argjson high "${HIGH}" --argjson med "${MED}" --argjson low "${LOW}" \
    '{repo: $repo, counts: {critical: $crit, high: $high, medium: $med, low: $low}, alerts: $alerts}'
else
  echo "GitHub Security alerts for ${GH_REPO}"
  echo "  Critical: ${CRIT}   High: ${HIGH}   Medium: ${MED}   Low: ${LOW}   (total open: ${TOTAL})"
  echo
  if [[ "${TOTAL}" -gt 0 ]]; then
    echo "${NORMALIZED}" | jq -r '
      # Sort so critical + high float to the top
      def sev_rank: {critical: 0, high: 1, medium: 2, low: 3,
                     error: 4, warning: 5, note: 6, unknown: 7}[.] // 8;
      sort_by(.severity | sev_rank)
      | .[]
      | "  [\(.severity | ascii_upcase)] \(.source): \(.title)\n    \(.location)\n    \(.url)"
    '
  else
    echo "  No open alerts. Nothing to review."
  fi
fi

# Decide the exit code based on the fail-severity list.
FAIL=0
IFS=',' read -ra WATCH <<< "${SEVERITY_FAIL}"
for sev in "${WATCH[@]}"; do
  n="$(count_sev "${sev}")"
  if [[ "${n}" -gt 0 ]]; then
    FAIL=1
  fi
done
exit "${FAIL}"
