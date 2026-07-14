/**
 * #313: SECURITY.md disclosure policy at repo root.
 *
 * Pins the minimum content the policy must carry. Regressions here typically
 * happen when someone edits SECURITY.md and accidentally drops a section --
 * scope, SLA, or safe-harbor language are the ones researchers actually
 * check before submitting, so losing them silently is a real cost.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SECURITY = read('SECURITY.md');
const ABOUT = read('about.html');

describe('SECURITY.md disclosure policy', () => {
  test('file exists at repo root', () => {
    expect(fs.existsSync(path.join(ROOT, 'SECURITY.md'))).toBe(true);
  });

  test('advertises private GitHub security advisories as the preferred channel', () => {
    expect(SECURITY).toMatch(/github\.com\/mdeguzis\/proton-pulse-web\/security\/advisories/);
    expect(SECURITY.toLowerCase()).toContain('preferred');
  });

  test('provides an email fallback', () => {
    expect(SECURITY).toContain('mdeguzis@gmail.com');
  });

  test('states the response SLA (72 hours + one week)', () => {
    expect(SECURITY).toMatch(/72 hours/);
    expect(SECURITY).toMatch(/one week/i);
  });

  test('spells out in-scope and out-of-scope sections', () => {
    expect(SECURITY.toLowerCase()).toContain('in scope');
    expect(SECURITY.toLowerCase()).toContain('out of scope');
    // must cover the surfaces users can attack that we own
    expect(SECURITY).toContain('proton-pulse.com');
    expect(SECURITY).toContain('supabase/functions/');
    expect(SECURITY).toContain('public-steam-profile');
  });

  test('carries safe-harbor language for good-faith research', () => {
    expect(SECURITY.toLowerCase()).toContain('safe harbor');
    // negation clauses researchers look for
    expect(SECURITY).toMatch(/will not initiate legal action/i);
  });

  test('sets a coordinated-disclosure default window', () => {
    expect(SECURITY).toMatch(/90 days/);
  });

  test('cross-links to the plugin repo SECURITY.md so researchers land in one place', () => {
    expect(SECURITY).toMatch(/decky-proton-pulse/);
  });
});

describe('about.html Safety and Security section links to SECURITY.md', () => {
  test('a card links to the full policy at the repo root', () => {
    // The Safety section already has a Pen testing card that links to
    // GitHub Security Advisories; the SECURITY.md link is the "read the
    // whole policy" landing spot for researchers.
    expect(ABOUT).toMatch(/blob\/main\/SECURITY\.md/);
  });

  test('the same card mentions the mirrored plugin repo policy', () => {
    // Kept together so researchers see one policy in two repos.
    expect(ABOUT).toMatch(/decky-proton-pulse\/blob\/main\/SECURITY\.md/);
  });
});
