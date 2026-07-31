/**
 * #439: top-nav dropdowns must not stack open. A click pins a panel via
 * .is-open; CSS :hover opens a panel too. Without clearing the pin when the
 * pointer enters a sibling, both panels show at once. wireDropdowns() clears
 * the pin on any dropdown mouseenter so hover is the single source of truth.
 *
 * topbar.js is one big IIFE that runs on load, so like the other topbar tests
 * we assert on the source wiring rather than booting the whole bar in jsdom.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'topbar.js'), 'utf8');

describe('#439: nav dropdowns do not stack open', () => {
  test('wireDropdowns attaches a mouseenter handler to each dropdown', () => {
    const idx = SRC.indexOf('function wireDropdowns');
    expect(idx).toBeGreaterThan(0);
    const slice = SRC.slice(idx, idx + 1400);
    expect(slice).toContain("dd.addEventListener('mouseenter'");
  });

  test('mouseenter clears the .is-open pin on the OTHER dropdowns', () => {
    const idx = SRC.indexOf("dd.addEventListener('mouseenter'");
    expect(idx).toBeGreaterThan(0);
    const slice = SRC.slice(idx, idx + 400);
    expect(slice).toContain('if (other !== dd)');
    expect(slice).toContain("other.classList.remove('is-open')");
    // and resets the sibling toggle's aria-expanded for a11y correctness
    expect(slice).toContain("setAttribute('aria-expanded', 'false')");
  });
});
