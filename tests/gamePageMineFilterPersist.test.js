/**
 * #390: "My Reports" filter chip on the game reports page.
 *
 * Structural tests only -- game-page.js is a large IIFE that does its work
 * against real DOM + localStorage. Same pattern as filterSaveExplicit.test.js.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);

describe('#390 "Mine" filter chip', () => {
  test('matches reports by BOTH client_id and proton_pulse_user_id', () => {
    const idx = src.indexOf('if (filterMine) {');
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 300);
    expect(slice).toContain('getWebClientId()');
    expect(slice).toContain('window._ppMyUserId');
    expect(slice).toMatch(/r\.clientId === myCid/);
    expect(slice).toMatch(/r\.protonPulseUserId === myPpid/);
  });

  test('the chip is hidden entirely when signed out, not just disabled', () => {
    expect(src).toContain('const _signedIn = !!window._ppMyUserId;');
    expect(src).toMatch(/\$\{_signedIn \? `<button class="sort-mine-btn/);
  });

  test('filterMine only initializes true while signed in', () => {
    expect(src).toContain('let filterMine = _signedIn && !!persistedFilters.mine;');
  });

  test('mine is part of the persisted filter snapshot, same as the other chips', () => {
    const idx = src.indexOf('function _filterSnapshot()');
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 700);
    expect(slice).toContain('mine: filterMine');
  });

  test('toggling Mine caches into the session snapshot and marks Save dirty, like the dropdown filters', () => {
    const idx = src.indexOf("el.querySelector('.sort-mine-btn')?.addEventListener('click'");
    expect(idx).toBeGreaterThan(0);
    const slice = src.slice(idx, idx + 500);
    expect(slice).toContain("_cacheField('mine', filterMine)");
    expect(slice).toContain('_updateSaveButtonState()');
    expect(slice).toContain('refreshReports()');
    // Same explicit-Save contract as every other filter (#415 slice 1):
    // toggling must not itself touch localStorage.
    expect(slice).not.toContain('localStorage.setItem');
  });
});
