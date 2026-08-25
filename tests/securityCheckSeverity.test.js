/**
 * `make security-check` must bucket code-scanning alerts by SECURITY severity.
 *
 * GitHub gives a code-scanning alert two different severities and they share
 * no vocabulary:
 *   rule.severity                 note | warning | error      (analysis)
 *   rule.security_severity_level  low | medium | high | critical
 *
 * The script normalised on rule.severity, so every code-scanning alert landed
 * in no bucket at all. Alert 60 -- js/xss-through-dom, security severity high,
 * rule severity warning -- printed as "High: 0 (total open: 1)" and exited 0.
 * The gate built to stop exactly that kind of finding waved it through (#502).
 *
 * This drives the script's REAL jq program against fixtures rather than a
 * copy, so the test cannot drift away from what ships.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts/check-github-security.sh');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

// Pull the normalisation program out of the script so the test runs the
// shipped jq, not a transcription of it.
function extractJqProgram() {
  const start = SRC.indexOf("--argjson ss \"${SECRET_SCAN_JSON}\" '");
  expect(start).toBeGreaterThan(-1);
  const from = SRC.indexOf("'", start + "--argjson ss \"${SECRET_SCAN_JSON}\" ".length) + 1;
  const end = SRC.indexOf("')\"", from);
  expect(end).toBeGreaterThan(from);
  return SRC.slice(from, end);
}

function normalize({ dependabot = [], codeScanning = [], secrets = [] }) {
  const out = execFileSync('jq', [
    '-n',
    '--argjson', 'dep', JSON.stringify(dependabot),
    '--argjson', 'cs', JSON.stringify(codeScanning),
    '--argjson', 'ss', JSON.stringify(secrets),
    extractJqProgram(),
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

const xssAlert = {
  rule: {
    id: 'js/xss-through-dom',
    description: 'DOM text reinterpreted as HTML',
    severity: 'warning',
    security_severity_level: 'high',
  },
  most_recent_instance: { location: { path: 'js/app/components/game-page.js', start_line: 1518 } },
  html_url: 'https://example.invalid/60',
  created_at: '2026-08-25T00:00:00Z',
};

describe('check-github-security.sh severity normalisation', () => {
  test('a high security severity is not masked by a warning rule severity', () => {
    const [alert] = normalize({ codeScanning: [xssAlert] });
    expect(alert.severity).toBe('high');
    expect(alert.rule_severity).toBe('warning');
  });

  test('critical security severity survives too', () => {
    const [alert] = normalize({
      codeScanning: [{ ...xssAlert, rule: { ...xssAlert.rule, security_severity_level: 'critical' } }],
    });
    expect(alert.severity).toBe('critical');
  });

  test('a quality rule with no security severity keeps its analysis severity', () => {
    // Deliberate: "warning" matches nothing in the critical,high fail list, so
    // a pure code-quality finding still cannot fail the gate.
    const [alert] = normalize({
      codeScanning: [{ ...xssAlert, rule: { id: 'js/unused-local', severity: 'warning' } }],
    });
    expect(alert.severity).toBe('warning');
    expect(['critical', 'high']).not.toContain(alert.severity);
  });

  test('dependabot advisories still normalise on advisory severity', () => {
    const [alert] = normalize({
      dependabot: [{
        security_advisory: { severity: 'high', summary: 'bad dep' },
        dependency: { package: { name: 'left-pad' } },
        html_url: 'https://example.invalid/1',
        created_at: '2026-08-25T00:00:00Z',
      }],
    });
    expect(alert.severity).toBe('high');
    expect(alert.source).toBe('dependabot');
  });

  test('secret scanning stays critical', () => {
    const [alert] = normalize({
      secrets: [{
        secret_type_display_name: 'GitHub PAT',
        locations: [{ details: { path: '.env', commit_sha: 'abcdef1234' } }],
        html_url: 'https://example.invalid/2',
        created_at: '2026-08-25T00:00:00Z',
      }],
    });
    expect(alert.severity).toBe('critical');
  });

  test('the script reads security_severity_level, not just rule.severity', () => {
    expect(SRC).toContain('.rule.security_severity_level');
  });
});
