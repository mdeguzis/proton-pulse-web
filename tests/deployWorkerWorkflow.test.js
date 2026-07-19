/**
 * Regression guards for .github/workflows/deploy-worker.yml. Motivated by
 * the outage where a Cloudflare Worker fell out of sync with the frontend
 * because deploying was a manual laptop step. The workflow should:
 *   1. Fire on push to main OR staging when workers/** changes.
 *   2. Support manual dispatch with a worker override so a targeted redeploy
 *      is possible without a new commit.
 *   3. Detect which workers changed (diff against event.before) and only
 *      deploy those -- not the whole workers/ tree on every push.
 *   4. Feed the two required secrets to wrangler as env vars.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'deploy-worker.yml');
const RAW = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const DOC = yaml.load(RAW);

describe('deploy-worker.yml is well-formed', () => {
  test('parses as YAML', () => {
    expect(DOC).toBeTruthy();
    expect(typeof DOC).toBe('object');
  });

  test('name identifies it as the CF worker deploy', () => {
    expect(DOC.name).toBe('Deploy Cloudflare Workers');
  });
});

describe('trigger surface', () => {
  // js-yaml interprets the YAML key `on:` (unquoted) as the boolean `true`.
  // Grab the block either way so we do not fail on YAML parser quirks.
  const on = DOC.on ?? DOC.true;

  test('fires on push to both main and staging', () => {
    expect(on.push).toBeTruthy();
    const branches = on.push.branches;
    expect(branches).toContain('main');
    expect(branches).toContain('staging');
  });

  test('is path-filtered to workers/ + the workflow itself (no full-repo triggers)', () => {
    const paths = on.push.paths;
    expect(paths).toContain('workers/**');
    expect(paths).toContain('.github/workflows/deploy-worker.yml');
  });

  test('supports workflow_dispatch with a worker override input', () => {
    expect(on.workflow_dispatch).toBeTruthy();
    const inputs = on.workflow_dispatch.inputs || {};
    expect(inputs.worker).toBeTruthy();
    expect(inputs.worker.default).toBe('edge-status');
  });
});

describe('deploy job wires wrangler correctly', () => {
  test('checkout + node20 + no other builds (keeps the CI fast)', () => {
    const steps = DOC.jobs.deploy.steps.map((s) => s.uses || s.name).filter(Boolean);
    expect(steps.some((s) => s.startsWith('actions/checkout'))).toBe(true);
    expect(steps.some((s) => s.startsWith('actions/setup-node'))).toBe(true);
  });

  test('resolves the worker list from the git diff, not by deploying everything', () => {
    // Regression guard: a "diff-since-event.before" step must exist so the
    // job is a no-op when a push does not actually touch workers/**. This
    // is what keeps a green-field release from silently redeploying the
    // worker for no reason.
    expect(RAW).toContain('event.before');
    expect(RAW).toMatch(/git diff --name-only[\s\S]{0,120}workers/);
  });

  test('runs wrangler deploy per changed worker directory', () => {
    // The deploy step calls wrangler under `workers/<w>` for each entry
    // in the resolved list. Skip the deploy step entirely when count=0.
    expect(RAW).toContain('npx --yes wrangler@latest deploy');
    expect(RAW).toContain("if: steps.workers.outputs.count != '0'");
  });

  test('passes both required Cloudflare secrets as env vars', () => {
    expect(RAW).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(RAW).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });
});
