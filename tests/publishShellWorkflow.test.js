/**
 * Regression guards for .github/workflows/publish-shell.yml (#362 follow-up).
 * This workflow is what keeps the CF Pages staging + prod deploys fresh on
 * every push. Motivating incident: after the CF migration, `make gh-staging`
 * kept pushing to the retired gh-pages staging repo and CF Pages stayed at
 * the version it happened to have at cutover time. Users saw a "JSON.parse:
 * unexpected character" on the status page because cert-status.json wasn't
 * in the deploy.
 *
 * The workflow should:
 *   1. Fire on push to both staging AND main, path-filtered so shell edits
 *      trigger and pipeline-only edits do not.
 *   2. Route the deploy to the correct CF Pages project per branch
 *      (proton-pulse-web-staging for staging, proton-pulse-web for main).
 *   3. Preserve the small top-level data JSON files + cert-status.json /
 *      cert-history.json from origin/gh-pages so the deploy is never
 *      missing the files the browser fetches same-origin.
 *   4. Run publish-cloudflare.sh with SKIP_R2_SYNC=1 -- shell-only.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'publish-shell.yml');
const RAW = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const DOC = yaml.load(RAW);

describe('publish-shell.yml is well-formed', () => {
  test('parses as YAML', () => {
    expect(DOC).toBeTruthy();
    expect(typeof DOC).toBe('object');
  });

  test('name identifies it as the CF Pages shell publish', () => {
    expect(DOC.name).toBe('Publish Shell to Cloudflare Pages');
  });
});

describe('trigger surface', () => {
  // js-yaml treats the unquoted `on:` key as boolean true; support either.
  const on = DOC.on ?? DOC.true;

  test('fires on push to both staging and main', () => {
    expect(on.push).toBeTruthy();
    const branches = on.push.branches;
    expect(branches).toContain('staging');
    expect(branches).toContain('main');
  });

  test('path filter includes html + css + js + manifest but not scripts/pipeline', () => {
    const paths = on.push.paths;
    expect(paths).toContain('*.html');
    expect(paths).toContain('css/**');
    expect(paths).toContain('js/**');
    expect(paths).toContain('gh-pages-manifest.txt');
    // The workflow itself should trigger a re-deploy on edit.
    expect(paths).toContain('.github/workflows/publish-shell.yml');
    // Regression guard: do NOT include scripts/pipeline or supabase/ or the
    // main data workflow -- those are handled by update-data.yml, and
    // triggering both on the same push would burn build minutes on a
    // deploy that has no user-visible effect.
    expect(paths).not.toContain('scripts/pipeline/**');
    expect(paths).not.toContain('supabase/**');
    expect(paths).not.toContain('.github/workflows/update-data.yml');
  });

  test('workflow_dispatch is available for manual re-runs', () => {
    // Empty object (no inputs) is deliberate -- there is nothing to
    // parameterize; the branch you dispatch from is the target.
    expect(on).toHaveProperty('workflow_dispatch');
  });
});

describe('concurrency serializes CF Pages deploys across workflows', () => {
  test('group name keys on the destination CF Pages project (shared with update-data.yml finalize)', () => {
    // Same group name as update-data.yml's finalize job means shell publish
    // and full pipeline can never both deploy to the same project at once.
    // Group must key on the DESTINATION project, not github.ref_name, so a
    // pipeline manual-dispatched on main with staging_with_finalize=true
    // shares the STAGING group with a staging push.
    expect(DOC.concurrency).toBeTruthy();
    expect(DOC.concurrency.group).toMatch(/^cf-pages-/);
    expect(DOC.concurrency.group).toContain('proton-pulse-web-staging');
    expect(DOC.concurrency.group).toContain('proton-pulse-web');
  });

  test('cancel-in-progress is false so a shell push does not kill a running pipeline', () => {
    // The pipeline can be an 80-min job; a shell push should NOT abort it.
    // The version-check in publish-cloudflare.sh is the second safety net
    // that keeps a stale pipeline from overwriting a fresh shell push.
    expect(DOC.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('publish job wires the deploy correctly', () => {
  const steps = DOC.jobs.publish.steps;

  test('checkout uses fetch-depth 0 so git-show from origin/gh-pages works', () => {
    // preserve-cert-monitor.sh + the "Pull top-level data" step both need
    // to git show from origin/gh-pages. Shallow clone breaks that with a
    // silent empty file.
    const checkout = steps.find((s) => (s.uses || '').startsWith('actions/checkout'));
    expect(checkout).toBeTruthy();
    expect(checkout.with['fetch-depth']).toBe(0);
  });

  test('node 22 pinned (wrangler 4.x requirement, matches deploy-worker.yml)', () => {
    const setupNode = steps.find((s) => (s.uses || '').startsWith('actions/setup-node'));
    expect(setupNode).toBeTruthy();
    expect(String(setupNode.with['node-version'])).toBe('22');
  });

  test('deploy target step maps staging->staging-project and main->prod-project', () => {
    // The mapping IS the whole point of the workflow -- picking the wrong
    // CF Pages project would either wipe prod (bad) or leave staging stale
    // (the original bug). Regression guard on the raw text so a future
    // refactor cannot silently rearrange it.
    expect(RAW).toMatch(/if\s*\[\s*"\$REF_NAME"\s*=\s*"staging"\s*\]/);
    expect(RAW).toContain('project=proton-pulse-web-staging');
    expect(RAW).toContain('project=proton-pulse-web');
  });

  test('pulls SMALL_DATA files from origin/gh-pages so the deploy is complete', () => {
    // Without this step the deployed shell is missing search-index.json,
    // most_played.json, data-versions.json, etc. and same-origin fetches
    // from the browser fail with the "JSON.parse: unexpected character"
    // error that motivated this workflow. Regression guard on the loop
    // shape + a representative file name.
    expect(RAW).toContain('git show "origin/gh-pages:$f"');
    expect(RAW).toContain('search-index.json');
    expect(RAW).toContain('data-versions.json');
  });

  test('cert-status.json + cert-history.json are handled via publish-cloudflare.sh', () => {
    // Those two files live under a separate script (preserve-cert-monitor.sh)
    // which publish-cloudflare.sh invokes internally -- so this workflow
    // just needs to run publish-cloudflare.sh with the right args. Guard
    // that the invocation is there. If preserve-cert-monitor.sh is ever
    // pulled out of publish-cloudflare.sh, THIS test still passes (that is
    // publish-cloudflare.sh's contract to keep); a separate assertion in
    // that contract's tests should catch a break there.
    expect(RAW).toContain('bash scripts/publish-cloudflare.sh');
  });

  test('deploys via publish-cloudflare.sh with SKIP_R2_SYNC=1', () => {
    // Shell-only mode: the per-game data buckets stay in R2 as they are;
    // the pipeline refreshes them on its own cadence. Any drop of the flag
    // would run a 187k-object sync on every push and 30-minute up the
    // wall time -- silently.
    expect(RAW).toContain('SKIP_R2_SYNC:');
    expect(RAW).toMatch(/SKIP_R2_SYNC:\s*['"]1['"]/);
    expect(RAW).toContain('scripts/publish-cloudflare.sh');
  });

  test('passes both required Cloudflare secrets as env vars', () => {
    expect(RAW).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(RAW).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });
});
