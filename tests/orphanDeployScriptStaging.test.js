/**
 * Scripts invoked after the gh-pages orphan deploy must be staged outside the
 * workspace first.
 *
 * The finalize job's "Deploy to gh-pages (orphan, no history)" step runs
 * `git rm -rf .`, which deletes every tracked file in the workspace. Any later
 * step that shells out to a repo script therefore has to run it from a copy
 * made BEFORE that wipe -- the preserve-* scripts already do this.
 *
 * backup-to-release.sh did not. Every scheduled run from 2026-08-19 onward
 * failed with "scripts/backup-to-release.sh: No such file or directory" and
 * the nightly data backup stopped for five days. The workflow still reported
 * the deploy as done; only the trailing backup step went red.
 *
 * This pins the invariant rather than the single fix, so the next script added
 * after the orphan step cannot reintroduce it.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const WF_PATH = path.join(__dirname, '..', '.github/workflows/update-data.yml');
const RAW = fs.readFileSync(WF_PATH, 'utf8');
// js-yaml reads the unquoted `on:` key as boolean true; irrelevant here, we
// only walk jobs.
const WF = yaml.load(RAW);
const FINALIZE = WF.jobs.finalize;

function stepIndex(pred) {
  return FINALIZE.steps.findIndex(pred);
}

describe('gh-pages orphan wipe does not strip scripts later steps need', () => {
  const orphanIdx = stepIndex(s => /Deploy to gh-pages \(orphan/.test(s.name || ''));

  test('the orphan deploy step exists and still wipes the workspace', () => {
    expect(orphanIdx).toBeGreaterThan(-1);
    expect(FINALIZE.steps[orphanIdx].run).toMatch(/git rm -rf \./);
  });

  test('no step after the wipe runs a script from the workspace path', () => {
    const after = FINALIZE.steps.slice(orphanIdx + 1);
    const offenders = [];
    for (const step of after) {
      const run = step.run || '';
      // `bash scripts/foo.sh` / `sh scripts/foo.sh` / bare `scripts/foo.sh`
      const m = run.match(/(?:^|\n)\s*(?:bash |sh |\.\/)?(scripts\/[\w.-]+\.sh)/g);
      if (m) offenders.push({ name: step.name, refs: m.map(x => x.trim()) });
    }
    expect(offenders).toEqual([]);
  });

  test('backup runs from the staged /tmp copy, not the workspace', () => {
    const backup = FINALIZE.steps.find(s => /Backup data to GitHub Release/.test(s.name || ''));
    expect(backup).toBeDefined();
    expect(backup.run).toMatch(/bash \/tmp\/backup-to-release\.sh/);
    expect(backup.run).not.toMatch(/scripts\/backup-to-release\.sh/);
  });

  test('exactly one step stages the backup script', () => {
    // #488 merged two independent fixes for #494, leaving two identical cp
    // steps. Harmless (the copy is idempotent) but the next reader cannot tell
    // which one is load-bearing, and deleting "the redundant one" is how the
    // bug comes back.
    const stagers = FINALIZE.steps.filter(s => (s.run || '').includes('cp scripts/backup-to-release.sh /tmp/'));
    expect(stagers).toHaveLength(1);
  });

  test('the staging copy happens before the wipe, on every deploy target', () => {
    const stageIdx = stepIndex(s => (s.run || '').includes('cp scripts/backup-to-release.sh /tmp/'));
    expect(stageIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeLessThan(orphanIdx);
    // The orphan step is skipped when deploy_target=cloudflare, but the backup
    // step still runs, so the staging copy must not be gated on that target.
    const stage = FINALIZE.steps[stageIdx];
    expect(String(stage.if || '')).not.toMatch(/deploy_target/);
  });

  test('staging copy and backup share the same run condition', () => {
    const stage = FINALIZE.steps[stepIndex(s => (s.run || '').includes('cp scripts/backup-to-release.sh /tmp/'))];
    const backup = FINALIZE.steps.find(s => /Backup data to GitHub Release/.test(s.name || ''));
    // Otherwise the backup could fire on a run where the copy never happened.
    expect(String(stage.if || '').trim()).toBe(String(backup.if || '').trim());
  });
});
