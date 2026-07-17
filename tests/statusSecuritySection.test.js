/**
 * Pin the status-page Security section to "scanner tiles only".
 *
 * The previous implementation also listed every open security issue and
 * posted an "N open" counter, which duplicated information already
 * canonical on GitHub. Regressions that re-add the issue list would push
 * this file back over that line, so lock it here.
 */
const fs = require('fs');
const path = require('path');

const STATUS_MAIN = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'status', 'main.js'),
  'utf8',
);
const STATUS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'status.html'),
  'utf8',
);
const SECURITY_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE', 'security_report.yml'),
  'utf8',
);

describe('status page Security section', () => {
  test('renders the six scanner-status tiles', () => {
    for (const label of ['CodeQL', 'Dependabot', 'npm audit', 'Rate limiting', 'CSP', 'RLS']) {
      expect(STATUS_MAIN).toContain(label);
    }
  });

  test('does NOT fetch or render the security-labeled issue list', () => {
    // The whole point of the cleanup: this section stops mirroring the
    // GitHub issue tracker. If someone re-adds either of these, the
    // section drifts back into a running bug list.
    expect(STATUS_MAIN).not.toMatch(/labels=security/);
    expect(STATUS_MAIN).not.toMatch(/renderSecurityIssue/);
  });

  test('does NOT post an "N open security issues" counter', () => {
    expect(STATUS_MAIN).not.toMatch(/open security issue/);
    expect(STATUS_MAIN).not.toMatch(/openCount/);
  });

  test('does not schedule a 5-minute security refresh (the section is now static)', () => {
    // Announcements still have a setInterval; security should not.
    const securityBlock = STATUS_MAIN.slice(STATUS_MAIN.indexOf('Security scanner posture'));
    expect(securityBlock).not.toMatch(/setInterval\([\s\S]{0,60}Security/);
  });

  test('Report link points to the public issue template, not the private advisories page', () => {
    // The private advisories path requires a GitHub account AND is meant for
    // confidential exploit disclosure -- most user-visible concerns should
    // go to the plain issue template so a normal visitor can file one.
    // Private disclosure is still linked from inside the template body.
    expect(STATUS_HTML).toContain('issues/new?template=security_report.yml');
    expect(STATUS_HTML).toContain('Report a security concern');
    expect(STATUS_HTML).not.toMatch(/href="https:\/\/github\.com\/[^"]+\/security\/advisories"/);
  });

  test('security issue template exists and links to the private advisories path for real exploits', () => {
    // The template body must tell reporters to use the private path if what
    // they found is an actual working exploit; posting one on a public
    // issue is a gift to attackers until the fix ships.
    expect(SECURITY_TEMPLATE).toContain('name: Security Concern');
    expect(SECURITY_TEMPLATE).toContain('security/advisories/new');
    // Category dropdown is required so triage does not have to guess.
    expect(SECURITY_TEMPLATE).toContain('label: What kind of concern');
  });
});
