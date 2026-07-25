/**
 * Regression guards for the CF Pages "no-going-backwards" deploy safety
 * that lands across two files (#362 follow-up).
 *
 * Motivating incident: gh-staging-finalize was dispatched at 22:22 UTC on a
 * stale checkout (sha 27a90ba61). Its finalize job ran ~80 min and finished
 * at 00:33 UTC, deploying 27a90ba61 to CF Pages -- overwriting the newer
 * publish-shell.yml deploys of feba53ca2 (23:29 UTC) and 9540965af (23:39
 * UTC). Live staging then showed the older sha with a newer deployed_at.
 *
 * Fix has two layers:
 *   A. Shared concurrency group cf-pages-<project> across publish-shell.yml
 *      and update-data.yml's finalize job (queue, no cancel) so they can
 *      never run in parallel.
 *   B. Version-check in publish-cloudflare.sh that refuses to deploy an
 *      older git commit on top of a newer one, catching the pipeline-with-
 *      stale-checkout case even after A serializes the runs.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const UPDATE_DATA_PATH = path.join(__dirname, '..', '.github', 'workflows', 'update-data.yml');
const PUBLISH_SHELL_PATH = path.join(__dirname, '..', '.github', 'workflows', 'publish-shell.yml');
const PUBLISH_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'publish-cloudflare.sh');

const UPDATE_DATA_DOC = yaml.load(fs.readFileSync(UPDATE_DATA_PATH, 'utf8'));
const PUBLISH_SHELL_DOC = yaml.load(fs.readFileSync(PUBLISH_SHELL_PATH, 'utf8'));
const PUBLISH_SCRIPT_SRC = fs.readFileSync(PUBLISH_SCRIPT_PATH, 'utf8');

describe('shared concurrency group across CF Pages deploy paths', () => {
  test('update-data.yml finalize job joins cf-pages-<project> group', () => {
    // Both workflows must use the SAME group name pattern so their locks
    // interact. If a future edit renames one side, this test catches the
    // silent race that reintroduces.
    const finalizeJob = UPDATE_DATA_DOC.jobs.finalize;
    expect(finalizeJob).toBeTruthy();
    expect(finalizeJob.concurrency).toBeTruthy();
    expect(finalizeJob.concurrency.group).toMatch(/^cf-pages-/);
    // Must reference BOTH project names so the ternary maps by input flag.
    expect(finalizeJob.concurrency.group).toContain('proton-pulse-web-staging');
    expect(finalizeJob.concurrency.group).toContain('proton-pulse-web');
  });

  test('update-data.yml finalize does not cancel-in-progress', () => {
    // The finalize job can run 80+ min end-to-end. cancel-in-progress: true
    // would let a shell push kill it mid-run and burn all that work.
    const finalizeJob = UPDATE_DATA_DOC.jobs.finalize;
    expect(finalizeJob.concurrency['cancel-in-progress']).toBe(false);
  });

  test('publish-shell.yml uses the exact same group prefix', () => {
    // Sanity guard on the pairing. If either side changes group name
    // independently the concurrency stops working.
    expect(PUBLISH_SHELL_DOC.concurrency.group).toMatch(/^cf-pages-/);
    expect(PUBLISH_SHELL_DOC.concurrency['cancel-in-progress']).toBe(false);
  });
});

describe('publish-cloudflare.sh refuses to move the site backwards', () => {
  // The version-check compares our git commit ISO to the deployed_at on the
  // live version.json. Text-scan the script for the two anchors that make
  // the check work; a future refactor that drops either loses the guard.

  test('fetches live version.json before deploying', () => {
    // Uses the CF Pages custom domain per project (staging.proton-pulse.com
    // or www.proton-pulse.com). If the fetch fails, the script falls
    // through so we do not deadlock on network flakiness.
    expect(PUBLISH_SCRIPT_SRC).toMatch(/curl\s+-sf\s+--max-time\s+\d+\s+"https:\/\/\$LIVE_DOMAIN\/version\.json"/);
    expect(PUBLISH_SCRIPT_SRC).toContain('staging.proton-pulse.com');
    expect(PUBLISH_SCRIPT_SRC).toContain('www.proton-pulse.com');
  });

  test('compares our git commit ISO to the live commit_time (deployed_at fallback)', () => {
    // The core of the check. Uses git log --format=%cI HEAD for our side
    // (committer date, format includes the local offset e.g. -04:00) and
    // commit_time from the live JSON (UTC Z form). Comparing commit-to-
    // commit, NOT commit-vs-deployed_at: a slow pipeline that deploys
    // commit X hours late writes deployed_at >> commit-time(X), and a
    // newer commit Y pushed mid-run then loses that compare and gets
    // skipped (bit the #361 confidence fix). deployed_at remains only as
    // a one-time fallback for version.json written before commit_time.
    expect(PUBLISH_SCRIPT_SRC).toMatch(/git\s+-C\s+"\$REPO_DIR"\s+log\s+-1\s+--format=%cI\s+HEAD/);
    expect(PUBLISH_SCRIPT_SRC).toMatch(/\.get\(['"]commit_time['"]/);
    expect(PUBLISH_SCRIPT_SRC).toMatch(/live_ref_ts="\$\{live_commit_time:-\$live_deployed_at\}"/);
  });

  test('version.json records commit_time for the next deploy to compare against', () => {
    expect(PUBLISH_SCRIPT_SRC).toMatch(/"commit_time":"%s"/);
  });

  test('normalizes both timestamps to UTC before compare (offset bug fix)', () => {
    // Regression guard: an earlier version used sed 's/+00:00$/Z/' which
    // only handled commits already in UTC. A commit made in EDT
    // (-04:00) fell through unnormalized and the lexicographic compare
    // then said "2026-07-20T21:30:54-04:00" < "2026-07-21T01:24:28Z"
    // and SKIPPED the deploy even though the commit was really newer.
    // Fix: use `date -d "..." -u +%Y-%m-%dT%H:%M:%SZ` which prints UTC
    // regardless of the input offset.
    expect(PUBLISH_SCRIPT_SRC).toMatch(/date\s+-d\s+"\$our_commit_iso"\s+-u/);
    // And a fallback log line for the case where `date` itself refuses
    // the input (shouldn't happen on GNU date, but graceful degradation).
    expect(PUBLISH_SCRIPT_SRC).toMatch(/could not normalize/);
  });

  test('skips the wrangler deploy (exit 0) when our commit is older', () => {
    // exit 0 not exit 1 -- the concurrency lock succeeded, we just chose
    // not to move the site backwards. Failing the workflow would be
    // misleading (nothing is actually broken).
    expect(PUBLISH_SCRIPT_SRC).toMatch(/SKIP:[\s\S]{0,300}exit 0/);
    // The comparison must guard on OLDER, not NEWER (would deploy newer
    // sha only which is opposite of what we want).
    expect(PUBLISH_SCRIPT_SRC).toMatch(/"\$our_ts"\s*\\<\s*"\$live_ref_ts"/);
  });
});
