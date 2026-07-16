/**
 * Pins the per-IP rate-limit abuse check (#320) inside security-monitor.mjs
 * so the aggregate check cannot silently drift away from the per-IP
 * variant. Regressions here mean a persistent attacker slips past.
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', '.github/scripts/security-monitor.mjs'),
  'utf8',
);

describe('per-IP rate-limit abuse check (#320)', () => {
  test('the check function exists', () => {
    expect(SCRIPT).toContain('checkRateLimitAbusePerIp');
  });

  test('groups 429 hits by source IP', () => {
    expect(SCRIPT).toMatch(/byIp\.set\(ip,/);
    expect(SCRIPT).toMatch(/remote_addr|client_ip|x_forwarded_for/);
  });

  test('has a documented abuse threshold constant', () => {
    expect(SCRIPT).toMatch(/RATE_LIMIT_ABUSE_THRESHOLD\s*=\s*\d+/);
  });

  test('fires an alert with the offender list when the threshold is crossed', () => {
    expect(SCRIPT).toContain('Rate-limit abuse from single IP');
    expect(SCRIPT).toContain('Top offenders');
  });

  test('is wired into main() so the hourly run actually calls it', () => {
    expect(SCRIPT).toMatch(/await\s+checkRateLimitAbusePerIp\(\)/);
  });
});
