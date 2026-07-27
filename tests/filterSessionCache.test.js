/**
 * #415 slice 2b: filter state survives SPA navigation between game pages
 * without needing to press Save. F5 refresh still clears (slice 1 contract).
 *
 * Structural asserts on the game-page source: a module-level cache exists,
 * gets seeded from localStorage on first read, and every dropdown change +
 * Clear updates it so the next renderGamePage call sees the current state.
 */
const fs = require('fs');
const path = require('path');

const gameSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);
const reportsCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'reports.css'),
  'utf8'
);

describe('#415 slice 2b: game-page filter state survives SPA nav', () => {
  test('module-level _ephemeralGameFilters exists and starts null (F5 clears)', () => {
    expect(gameSrc).toMatch(/^let\s+_ephemeralGameFilters\s*=\s*null;\s*$/m);
  });

  test('seed prefers the cache when populated; falls back to localStorage on first entry', () => {
    // The persistedFilters IIFE reads the cache first, then hits storage
    // on cache miss.
    const idx = gameSrc.indexOf('const persistedFilters = (() => {');
    expect(idx).toBeGreaterThan(0);
    const slice = gameSrc.slice(idx, idx + 900);
    expect(slice).toContain('if (_ephemeralGameFilters !== null) return _ephemeralGameFilters');
    expect(slice).toContain('localStorage.getItem(FILTER_STORAGE_KEY)');
    expect(slice).toContain('_ephemeralGameFilters = JSON.parse');
  });

  test('every dropdown change writes back into the cache', () => {
    // _cacheField helper is defined once above the handlers and called by
    // each one with the same field name used in the snapshot object.
    expect(gameSrc).toContain('const _cacheField = (k, v) =>');
    for (const [id, key] of [
      ['fGpu', 'gpu'], ['fArch', 'arch'], ['fOs', 'os'], ['fRating', 'rating'],
      ['fRunType', 'runType'], ['fSource', 'source'], ['fDevice', 'device'],
      ['fPlaytime', 'minPlaytime'],
    ]) {
      const handlerIdx = gameSrc.indexOf(`el.querySelector('#${id}')`);
      expect(handlerIdx).toBeGreaterThan(0);
      const slice = gameSrc.slice(handlerIdx, handlerIdx + 500);
      expect(slice).toContain(`_cacheField('${key}',`);
    }
  });

  test('Clear also wipes the cache so nav-away-nav-back does not re-apply', () => {
    const idx = gameSrc.indexOf("document.getElementById('gp-filter-clear')");
    expect(idx).toBeGreaterThan(0);
    const slice = gameSrc.slice(idx, idx + 1000);
    expect(slice).toMatch(/_ephemeralGameFilters\.gpu\s*=\s*''/);
    expect(slice).toMatch(/_ephemeralGameFilters\.rating\s*=\s*''/);
    expect(slice).toMatch(/_ephemeralGameFilters\.source\s*=\s*''/);
    expect(slice).toMatch(/_ephemeralGameFilters\.minPlaytime\s*=\s*0/);
  });
});

describe('#415 slice 2b: filter panel drawer animation + accented dropdowns', () => {
  test('base .filter-panel keeps display:block and animates via max-height + opacity + transform', () => {
    // The closed state must NOT rely on display:none (unanimatable). The
    // transition list must cover the three properties we animate.
    expect(reportsCss).toMatch(/\.filter-panel\s*\{[^}]*display:\s*block[^}]*max-height:\s*0[^}]*opacity:\s*0/s);
    expect(reportsCss).toMatch(/\.filter-panel\s*\{[\s\S]*?transition:[\s\S]*?max-height[\s\S]*?opacity[\s\S]*?transform/);
    expect(reportsCss).toMatch(/\.filter-panel\.open\s*\{[^}]*max-height:\s*90vh[^}]*opacity:\s*1/s);
  });

  test('filter-panel--stack no longer forces display:none in the closed state', () => {
    // The old rule was "display: none" on --stack when closed, which would
    // clobber the animation. New selector is :not(.open) with display:block.
    expect(reportsCss).toContain('.filter-panel--stack:not(.open) { display: block; }');
    expect(reportsCss).not.toMatch(/^\.filter-panel--stack\s*\{\s*display:\s*none\s*;\s*\}/m);
  });

  test('filter-item select uses an accent-tinted border so it stands out from the panel', () => {
    expect(reportsCss).toMatch(/\.filter-item\s+select\s*\{[\s\S]*?border:\s*1px solid color-mix\(in srgb, var\(--accent\)/);
    expect(reportsCss).toContain('.filter-item select:hover');
    expect(reportsCss).toMatch(/\.filter-item\s+select:focus\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*box-shadow/s);
  });
});
