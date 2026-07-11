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
});
