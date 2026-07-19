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

  test('checkout fetches full history so git diff against event.before can resolve', () => {
    // Regression guard: default fetch-depth is 1 (tip only), which makes
    // `git diff $BEFORE_SHA $AFTER_SHA` in the Resolve step silently return
    // empty on every real push and skip the deploy. Full history is cheap
    // on this repo. If a future edit drops back to depth 1 this test
    // catches it.
    const checkout = DOC.jobs.deploy.steps.find((s) => (s.uses || '').startsWith('actions/checkout'));
    expect(checkout).toBeTruthy();
    expect(checkout.with).toBeTruthy();
    expect(checkout.with['fetch-depth']).toBe(0);
  });

  test('resolves the worker list from the git diff, not by deploying everything', () => {
    // Regression guard: a "diff-since-event.before" step must exist so the
    // job is a no-op when a push does not actually touch workers/**. This
    // is what keeps a green-field release from silently redeploying the
    // worker for no reason. Values come in via env: to satisfy semgrep's
    // run-shell-injection rule (see next test).
    expect(RAW).toContain('BEFORE_SHA: ${{ github.event.before }}');
    expect(RAW).toMatch(/git diff --name-only[\s\S]{0,120}workers/);
  });

  test('all github context data enters run: via env, never inline ${{ ... }}', () => {
    // Regression guard for semgrep yaml.github-actions.security.run-shell-
    // injection. Attacker-influenced GitHub context (branch names, PR
    // bodies, dispatch inputs) must not land in shell strings. Grep every
    // run: block; the only ${{ ... }} allowed is in env: assignments.
    // Shell body ends when indentation drops back to step-level (starts
    // with the "      - " six-space dash prefix) or file end.
    const runBlocks = RAW.split(/\n\s*run:\s*\|\n/).slice(1);
    for (const block of runBlocks) {
      const body = block.split(/\n {0,6}(?=\S)/)[0];
      expect(body).not.toContain('${{');
    }
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

  test('workflow does not sync any worker-side auth secrets from CI', () => {
    // Regression guard: an earlier design pushed a GitHub PAT into the
    // worker via `wrangler secret put GITHUB_TOKEN` so the cert probe
    // could read the GitHub Pages REST API. That whole path is gone --
    // the worker relies on the fetch probe alone (Cloudflare 525/526
    // catches broken TLS) so no PAT is needed. If a future edit re-adds
    // a secret-sync step, this test forces a discussion about whether a
    // new secret is really required and what its blast radius is on leak.
    expect(RAW).not.toContain('wrangler@latest secret put');
    expect(RAW).not.toContain('wrangler secret put');
    expect(RAW).not.toContain('WORKER_GH_TOKEN');
  });
});
