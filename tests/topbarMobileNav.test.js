/**
 * Mobile hamburger drawer now mirrors the desktop nav with expand/collapse
 * accordion groups (Browse / Resources) and carries the My Library / My
 * Wishlist items that were missing before.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'lib', 'topbar.js'),
  'utf8',
);

describe('mobile nav drawer accordion', () => {
  test('drawer has Browse + Resources accordion groups with parent buttons', () => {
    expect(SRC).toContain('class="mnav-group"');
    expect(SRC).toContain('class="mnav-parent" type="button" aria-expanded="false" data-group="browse"');
    expect(SRC).toContain('class="mnav-parent" type="button" aria-expanded="false" data-group="resources"');
    expect(SRC).toContain('class="mnav-caret"');
  });

  test('Browse group carries My Library and My Wishlist (the previously missing items)', () => {
    expect(SRC).toContain('id="mobile-my-library"');
    expect(SRC).toContain('id="mobile-my-wishlist"');
    expect(SRC).toContain('app.html?filter=mine');
    expect(SRC).toContain('app.html?filter=wishlist');
  });

  test('parent buttons toggle the sub-list open/closed without closing the drawer', () => {
    expect(SRC).toContain("drawer.querySelectorAll('.mnav-parent')");
    expect(SRC).toContain("btn.getAttribute('aria-expanded') === 'true'");
    expect(SRC).toContain("group.classList.toggle('mnav-open', !expanded)");
  });

  test('opening the drawer resets every accordion to collapsed', () => {
    expect(SRC).toContain('function collapseGroups()');
    expect(SRC).toContain("g.classList.remove('mnav-open')");
    // collapseGroups runs inside the open branch of the toggle handler.
    expect(SRC).toMatch(/if \(open\) \{[\s\S]*collapseGroups\(\);/);
  });

  test('opening a folded group auto-closes any other open group (#460)', () => {
    // Accordion pattern: only one section expanded at a time. Without this
    // opening Browse then tapping Resources leaves both expanded and pushes
    // every item off the bottom of the viewport.
    expect(SRC).toContain(".mnav-group.mnav-open");
    // Guard the exact contract: on expand (i.e. when the clicked parent is
    // NOT already expanded), iterate the open groups and reset them.
    expect(SRC).toMatch(/if\s*\(!expanded\)\s*\{[\s\S]*mnav-open[\s\S]*openGroup\.classList\.remove\(['"]mnav-open['"]\)/);
    expect(SRC).toMatch(/openBtn\.setAttribute\(['"]aria-expanded['"],\s*['"]false['"]\)/);
  });
});
