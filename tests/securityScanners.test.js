/**
 * Pins the three new security scanner workflows (#316, #317, #322) so
 * regressions that would silently disable a scanner fail CI.
 *
 * Each workflow lives at .github/workflows/<name>.yml. The tests here
 * only check the contract, not the runtime behavior -- the runtime is
 * verified by the workflows themselves on every push.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('Semgrep SAST workflow (#316)', () => {
  const YAML = read('.github/workflows/semgrep.yml');

  test('runs on push + PR against main and staging', () => {
    expect(YAML).toMatch(/branches:\s*\[main,\s*staging\]/);
  });

  test('runs on a weekly schedule so new upstream rules land without a push', () => {
    expect(YAML).toMatch(/cron:\s*"0 6 \* \* 1"/);
  });

  test('applies the TypeScript + OWASP + security-audit rulepacks', () => {
    expect(YAML).toContain('p/typescript');
    expect(YAML).toContain('p/owasp-top-ten');
    expect(YAML).toContain('p/security-audit');
  });

  test('runs the semgrep container so the toolchain does not have to be installed per job', () => {
    expect(YAML).toMatch(/image:\s*semgrep\/semgrep/);
  });

  test('excludes the github-actions-mutable-action-tag rule (Dependabot needs version tags)', () => {
    expect(YAML).toContain('github-actions-mutable-action-tag');
    expect(YAML).toContain('--exclude-rule');
  });
});

describe('SBOM + Grype scan workflow (#317)', () => {
  const YAML = read('.github/workflows/sbom.yml');

  test('runs on push + PR against main and staging', () => {
    expect(YAML).toMatch(/branches:\s*\[main,\s*staging\]/);
  });

  test('runs on a weekly schedule so new CVEs land without a push', () => {
    expect(YAML).toMatch(/cron:\s*"0 5 \* \* 1"/);
  });

  test('installs deps before generating the SBOM (otherwise transitive packages are missing)', () => {
    expect(YAML).toContain('npm ci');
  });

  test('emits a CycloneDX SBOM (native GitHub dependency graph format)', () => {
    expect(YAML).toMatch(/format:\s*cyclonedx-json/);
  });

  test('Grype fails the build on high or critical (matches npm audit gating)', () => {
    expect(YAML).toMatch(/anchore\/scan-action@v[4-9]/);
    expect(YAML).toMatch(/fail-build:\s*true/);
    expect(YAML).toMatch(/severity-cutoff:\s*high/);
  });

  test('uploads the SBOM as an artifact so tagged releases can attach it', () => {
    expect(YAML).toContain('actions/upload-artifact');
    expect(YAML).toContain('sbom.cyclonedx.json');
  });
});

describe('Quarterly restore drill reminder workflow (#322)', () => {
  const YAML = read('.github/workflows/restore-drill-reminder.yml');

  test('scheduled every 90 days (1st of Jan / Apr / Jul / Oct)', () => {
    expect(YAML).toMatch(/cron:\s*"0 15 1 1,4,7,10 \*"/);
  });

  test('grants issues:write so the workflow can open the drill issue', () => {
    expect(YAML).toMatch(/issues:\s*write/);
  });

  test('idempotent -- skips if an open drill issue for this quarter already exists', () => {
    // A manual workflow_dispatch run right after a scheduled one must
    // not spam a second identical issue.
    expect(YAML).toContain('is:issue is:open label:restore-drill');
    expect(YAML).toContain('Drill issue already open');
  });

  test('opens the issue with the restore-drill + security labels', () => {
    expect(YAML).toContain("labels: ['restore-drill', 'security']");
  });

  test('body links to the Restore-Runbook wiki + covers every checklist step', () => {
    expect(YAML).toContain('wiki/Restore-Runbook');
    for (const step of [
      'Pull the latest backup tarball',
      'Verify HMAC signature',
      'Spin a scratch Supabase project',
      'Restore schema + data',
      'Deploy every edge function',
      'Tear down the scratch project',
    ]) {
      expect(YAML).toContain(step);
    }
  });
});
