/**
 * #439: top-nav dropdowns are hover-only on desktop and must not stick open on
 * click. The CSS opens the panel on :hover, :focus-within AND .is-open, so a
 * mouse click otherwise pins it two ways (the class plus the focus it leaves).
 * wireDropdowns() gates click behavior on (hover: hover): desktop click closes
 * everything and blurs, so hover is the only open path; touch keeps click.
 *
 * topbar.js is one big IIFE that runs on load, so like the other topbar tests
 * we assert on the source wiring rather than booting the whole bar in jsdom.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'topbar.js'), 'utf8');

describe('#439: nav dropdowns are hover-only on desktop', () => {
  const idx = SRC.indexOf('function wireDropdowns');
  const block = SRC.slice(idx, idx + 1800);

  test('detects hover capability via matchMedia (hover: hover)', () => {
    expect(idx).toBeGreaterThan(0);
    expect(block).toContain("matchMedia('(hover: hover)')");
  });

  test('a desktop (hover) click does not pin the panel: it closes all and blurs', () => {
    expect(block).toContain('if (canHover)');
    expect(block).toContain('closeAll()');
    expect(block).toContain('toggle.blur()');
  });

  test('touch (no hover) still toggles .is-open on click so the panel can open', () => {
    // The non-hover branch keeps the click-to-toggle path.
    expect(block).toContain("dd.classList.toggle('is-open', !wasOpen)");
  });
});
