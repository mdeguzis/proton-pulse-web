/**
 * #218: standardized workflow_dispatch inputs across every dispatchable
 * pipeline workflow so a single-issue fix can be spot-verified via a
 * one-click dispatch that back-comments the result on the target issue.
 *
 * Contract:
 *  - Every workflow with a `workflow_dispatch` trigger declares `issue_id`
 *    and `dry_run` inputs.
 *  - Every such workflow ends with a `back-comment-run` step so the target
 *    issue gets a paper trail when the dispatch specified issue_id.
 *  - The shared composite action lives at `.github/actions/back-comment-run/`
 *    so all workflows call it via `uses: ./.github/actions/back-comment-run`.
 *  - Workflows that write to Supabase / commit to gh-pages guard their write
 *    steps behind `if: inputs.dry_run != true` so a preview dispatch reads
 *    but never mutates.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

// Workflows where standardization applies. Deploy/webhook/CI helpers that
// exist purely to reflect other events (retry-pages-build, discord-*,
// sync-staging-main, deploy-on-merge) don't take app_id / issue_id inputs and
// wouldn't benefit from the back-comment -- explicitly excluded so this test
// doesn't false-positive on infrastructure workflows.
const PIPELINE_WORKFLOWS = [
  'update-data.yml',
  'steam-metadata-fetch.yml',
  'content-moderation.yml',
  'backup.yml',
  'update-epic-catalog.yml',
  'update-gog-catalog.yml',
];

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
}

describe('#218: shared back-comment-run composite action', () => {
  const action = yaml.load(fs.readFileSync(
    path.join(ROOT, '.github', 'actions', 'back-comment-run', 'action.yml'),
    'utf8',
  ));

  test('declares issue_id, status, workflow_name, app_ids, dry_run inputs', () => {
    expect(action.inputs).toBeDefined();
    for (const key of ['issue_id', 'status', 'workflow_name', 'app_ids', 'dry_run']) {
      expect(action.inputs[key]).toBeDefined();
    }
  });

  test('is a composite action (not a JS/Docker action)', () => {
    expect(action.runs.using).toBe('composite');
  });

  test('no-ops when issue_id is empty so unconditional callers are safe', () => {
    const step = action.runs.steps.find((s) => s.if && s.if.includes('issue_id'));
    expect(step).toBeDefined();
    expect(step.if).toContain("inputs.issue_id != ''");
  });
});

describe.each(PIPELINE_WORKFLOWS)('#218: %s standardization', (fileName) => {
  const wf = loadWorkflow(fileName);
  // 'on' can be a string or object; workflow_dispatch definition lives under
  // wf.on.workflow_dispatch when present. YAML parses `on:` as `true` in some
  // parser versions (bool-yes), so accept either key.
  const onBlock = wf.on || wf.true;
  const dispatch = onBlock && onBlock.workflow_dispatch;

  test('has a workflow_dispatch trigger', () => {
    expect(dispatch).toBeDefined();
  });

  test('declares issue_id + dry_run inputs (standard #218 shape)', () => {
    expect(dispatch.inputs).toBeDefined();
    expect(dispatch.inputs.issue_id).toBeDefined();
    expect(dispatch.inputs.dry_run).toBeDefined();
    expect(dispatch.inputs.dry_run.type).toBe('boolean');
  });

  test('calls the shared back-comment-run composite action at the end of a job', () => {
    const allSteps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
    const backComment = allSteps.find(
      (s) => s.uses && s.uses.includes('.github/actions/back-comment-run'),
    );
    expect(backComment).toBeDefined();
    // Runs on always() so a failed job still posts the summary before the
    // fail step flips the run red.
    expect(backComment.if).toContain('always()');
    // Passes issue_id + status + workflow_name at minimum.
    expect(backComment.with).toBeDefined();
    expect(backComment.with.issue_id).toBeDefined();
    expect(backComment.with.status).toBeDefined();
    expect(backComment.with.workflow_name).toBeTruthy();
  });

  test('the job that calls back-comment-run grants issues:write permission', () => {
    // Without this, gh CLI 403s and the composite action can't post.
    const jobsWithBackComment = Object.values(wf.jobs).filter((j) =>
      (j.steps || []).some((s) => s.uses && s.uses.includes('.github/actions/back-comment-run')),
    );
    for (const job of jobsWithBackComment) {
      const perms = job.permissions;
      // permissions can be 'read-all', 'write-all', or an object -- accept
      // any shape that lets `issues: write` through.
      expect(perms).toBeDefined();
      if (typeof perms === 'object') {
        expect(perms.issues).toBe('write');
      }
    }
  });
});

describe('#218: content-moderation standardized on plural app_ids', () => {
  const wf = loadWorkflow('content-moderation.yml');
  const dispatch = (wf.on || wf.true).workflow_dispatch;

  test('input is app_ids (plural), not the legacy app_id (singular)', () => {
    expect(dispatch.inputs.app_ids).toBeDefined();
    expect(dispatch.inputs.app_id).toBeUndefined();
  });

  test('passes APP_IDS env to the moderation script', () => {
    const scriptStep = wf.jobs.moderate.steps.find(
      (s) => s.name && s.name.toLowerCase().includes('moderation'),
    );
    expect(scriptStep).toBeDefined();
    expect(scriptStep.env.APP_IDS).toBeDefined();
  });
});
