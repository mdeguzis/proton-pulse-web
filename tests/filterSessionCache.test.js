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
const filtersCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'shared', 'filters.css'),
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
  test('the drawer animation is the shared contract in filters.css (#417), covering every panel', () => {
    // #417: the clip-path drawer animation moved out of the app-only
    // reports.css into shared/filters.css so browse, game-page, index
    // (.pg-filter-panel) and the stats dropdowns (.filter-dropdown
    // .filter-panel) all reveal the same way. clip-path (not max-height)
    // keeps CSS multi-column layouts from reflowing into more/narrower
    // columns during the collapse -- the #415 slice 2b flash bug.
    // Closed state is fully clipped from the bottom; open clears the inset.
    expect(filtersCss).toMatch(/\.filter-panel,\s*\.pg-filter-panel\s*\{[\s\S]*?clip-path:\s*inset\(0 0 100% 0\)[\s\S]*?opacity:\s*0/);
    expect(filtersCss).toMatch(/\.filter-panel,\s*\.pg-filter-panel\s*\{[\s\S]*?transition:[\s\S]*?clip-path[\s\S]*?opacity[\s\S]*?transform/);
    expect(filtersCss).toMatch(/cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
    // Unified reveal selector: big panels flip .open on the panel, stats
    // flips .is-open on the parent -- all three reach the same open state.
    expect(filtersCss).toMatch(/\.filter-panel\.open,[\s\S]*?\.pg-filter-panel\.open,[\s\S]*?\.filter-dropdown\.is-open \.filter-panel\s*\{[\s\S]*?clip-path:\s*inset\(0 0 0 0\)[\s\S]*?opacity:\s*1/);
  });

  test('mobile <=720px keeps the panel position:fixed even when closed so collapse does not flash the desktop popover', () => {
    // Without a mobile base override, removing .open flips position:fixed
    // back to position:absolute mid-transition and the panel briefly
    // shape-shifts to the tiny top-left desktop popover.
    const mobileIdx = reportsCss.indexOf('@media (max-width: 720px)');
    expect(mobileIdx).toBeGreaterThan(0);
    const mobileSlice = reportsCss.slice(mobileIdx, mobileIdx + 800);
    expect(mobileSlice).toMatch(/\.filter-panel\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0/);
    expect(mobileSlice).toMatch(/\.filter-panel\s*\{[\s\S]*?height:\s*100dvh/);
  });

  test('filter-panel--stack keeps a single display value regardless of .open', () => {
    // Toggling display:block <-> flex on open/close reflows the content
    // instantly, which was the "portrait mode flash" bug during collapse.
    // Desktop stays flex, mobile stays block (matches shared/filters.css
    // modal !important). Neither depends on .open.
    expect(reportsCss).toMatch(/\.filter-panel--stack\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row/s);
    expect(reportsCss).not.toContain('.filter-panel--stack:not(.open)');
    expect(reportsCss).not.toMatch(/\.filter-panel--stack\.open\s*\{[^}]*display:\s*flex/s);
    // Mobile keeps block to match the shared modal's !important rule.
    const mobileIdx = reportsCss.indexOf('@media (max-width: 720px)');
    expect(mobileIdx).toBeGreaterThan(0);
    expect(reportsCss.slice(mobileIdx)).toMatch(/\.filter-panel--stack\s*\{[^}]*display:\s*block/s);
  });

  test('filter-item select uses an accent-tinted border so it stands out from the panel', () => {
    expect(reportsCss).toMatch(/\.filter-item\s+select\s*\{[\s\S]*?border:\s*1px solid color-mix\(in srgb, var\(--accent\)/);
    expect(reportsCss).toContain('.filter-item select:hover');
    expect(reportsCss).toMatch(/\.filter-item\s+select:focus\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*box-shadow/s);
  });
});
