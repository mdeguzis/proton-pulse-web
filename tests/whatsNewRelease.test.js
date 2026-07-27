/**
 * "What's New" -> GitHub releases + draft-release automation.
 *
 * Announcements move off the bespoke admin flow: the topbar links straight
 * to the repo's releases page (native image support, no custom editor),
 * and every prod deploy target leaves a pre-filled DRAFT release (version
 * title + commit bullets + placeholder prose) for the maintainer to rewrite and
 * publish. Publishing is always a human action.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TOPBAR = read('js/lib/topbar.js');
const MAKEFILE = read('Makefile');
const SCRIPT = read('scripts/draft-release.sh');

describe("What's New -> GitHub releases", () => {
  test('desktop and mobile nav both link to the releases page', () => {
    const links = TOPBAR.match(/github\.com\/mdeguzis\/proton-pulse-web\/releases/g) || [];
    expect(links.length).toBe(2);
    expect(TOPBAR).toContain("What's New");
    expect(TOPBAR).not.toContain('status.html#status-announcements');
  });
});

describe('draft-release automation', () => {
  test('prod deploy targets call the draft script', () => {
    expect(MAKEFILE).toContain('draft-release:');
    // Both prod paths (full pipeline + pages-only promote) leave a draft.
    const calls = MAKEFILE.match(/bash scripts\/draft-release\.sh/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // gh-run, gh-pages-only, draft-release
  });

  test('the script only ever drafts -- publishing stays human', () => {
    expect(SCRIPT).toContain('--draft');
    expect(SCRIPT).not.toMatch(/--draft=false/);
    expect(SCRIPT).toContain('Never publishes');
    // Refuses to touch an already-published version.
    expect(SCRIPT).toContain('already PUBLISHED');
  });

  test('draft body carries commit bullets and placeholder prose', () => {
    expect(SCRIPT).toContain("git log --format='- %s' --no-merges");
    // Noise commits are filtered from the user-facing notes.
    expect(SCRIPT).toContain("grep -vE '^- (test|chore|ci|docs)");
    expect(SCRIPT).toContain('## Highlights');
    expect(SCRIPT).toContain('rewrite the summary, add screenshots, then publish');
  });
});
