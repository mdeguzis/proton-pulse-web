/**
 * #415 slice 2: "Apply across the site" checkbox mirrors rating / source /
 * store fields into a shared storage key that every page reads on load.
 *
 * Two layers of asserts:
 *   1. Unit tests against the shared storage module (js/shared/filters-shared.js)
 *      exercised through a fake localStorage. Read / write / clear / isEnabled /
 *      readSharedField all round-trip.
 *   2. Structural asserts against the two call sites (game-page + home) so a
 *      later refactor cannot silently drop the wiring.
 */
const fs = require('fs');
const path = require('path');

// --- 1. Shared storage module: real behavior against a fake localStorage ---
describe('filters-shared: storage helpers', () => {
  const store = {};
  const fakeLS = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  let mod;

  beforeAll(() => {
    global.localStorage = fakeLS;
    // Ensure a fresh require -- the module snapshots localStorage once at
    // load time in some environments, so wipe cache to be safe.
    delete require.cache[require.resolve('../js/shared/filters-shared.js')];
    mod = require('../js/shared/filters-shared.js');
  });

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  test('readShared returns null when nothing has been written', () => {
    expect(mod.readShared()).toBeNull();
  });

  test('writeShared flips the enabled flag and stores the payload', () => {
    mod.writeShared({ rating: 'gold', source: 'pulse' });
    expect(mod.isEnabled()).toBe(true);
    expect(mod.readShared()).toEqual({ rating: 'gold', source: 'pulse' });
  });

  test('writeShared merges: partial writes from one page do not stomp fields owned by another', () => {
    mod.writeShared({ rating: 'gold', source: 'pulse' });
    mod.writeShared({ store: ['steam'] });
    expect(mod.readShared()).toEqual({
      rating: 'gold',
      source: 'pulse',
      store: ['steam'],
    });
  });

  test('clearShared drops both the payload and the enabled flag', () => {
    mod.writeShared({ rating: 'platinum' });
    mod.clearShared();
    expect(mod.readShared()).toBeNull();
    expect(mod.isEnabled()).toBe(false);
  });

  test('readShared returns null when the enabled flag is off, even if the key exists', () => {
    mod.writeShared({ rating: 'gold' });
    // Emulate the flag being turned off without clearing the payload
    fakeLS.removeItem('pp:filters-shared-enabled');
    expect(mod.readShared()).toBeNull();
    expect(mod.isEnabled()).toBe(false);
  });

  test('readSharedField normalises scalars and arrays to arrays; empty when nothing', () => {
    mod.writeShared({ rating: 'gold', source: ['pulse', 'protondb'] });
    expect(mod.readSharedField('rating')).toEqual(['gold']);
    expect(mod.readSharedField('source')).toEqual(['pulse', 'protondb']);
    expect(mod.readSharedField('store')).toEqual([]);
    mod.clearShared();
    expect(mod.readSharedField('rating')).toEqual([]);
  });

  test('writeShared silently ignores non-object input rather than corrupting state', () => {
    mod.writeShared({ rating: 'gold' });
    mod.writeShared(null);
    mod.writeShared('junk');
    expect(mod.readShared()).toEqual({ rating: 'gold' });
  });
});

// --- 2. Call-site wiring assertions --------------------------------------

const gameSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8'
);
const homeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8'
);
const reportsCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'reports.css'),
  'utf8'
);

describe('#415 slice 2: game page wires shared filter storage', () => {
  test('imports readSharedField / writeShared / clearShared / isEnabled', () => {
    expect(gameSrc).toMatch(/import\s+\{[^}]*readSharedField[^}]*writeShared[^}]*clearShared[^}]*isEnabled[^}]*\}\s+from\s+'\.\.\/\.\.\/shared\/filters-shared\.js/);
  });

  test('rating + source seed from shared when per-page snapshot is empty', () => {
    expect(gameSrc).toContain("_sharedRating = readSharedField('rating')[0]");
    expect(gameSrc).toContain("_sharedSource = readSharedField('source')[0]");
    expect(gameSrc).toContain('_restoreScalar(persistedFilters.rating) || _sharedRating');
    expect(gameSrc).toContain('_sharedSource ||');
  });

  test('_saveFiltersNow writes rating + source to shared when the box is ticked, or clears', () => {
    const idx = gameSrc.indexOf('function _saveFiltersNow');
    expect(idx).toBeGreaterThan(0);
    const slice = gameSrc.slice(idx, idx + 800);
    expect(slice).toContain('_shareAcrossSite');
    expect(slice).toContain('writeShared({ rating: filterRating, source: filterSource })');
    expect(slice).toContain('clearShared()');
  });

  test('checkbox HTML lives in the panel footer with an accessible label', () => {
    expect(gameSrc).toContain('id="gp-filter-share"');
    expect(gameSrc).toContain('Apply across the site');
    expect(gameSrc).toContain('filter-share-toggle');
  });

  test('checkbox change handler flips the in-memory flag and reflects on the Save button', () => {
    const idx = gameSrc.indexOf("document.getElementById('gp-filter-share')");
    expect(idx).toBeGreaterThan(0);
    const slice = gameSrc.slice(idx, idx + 300);
    expect(slice).toContain('_shareAcrossSite = !!e.target.checked');
    expect(slice).toContain('_updateSaveButtonState()');
  });

  test('_isDirty treats a mismatched share flag as unsaved', () => {
    expect(gameSrc).toContain('if (_shareAcrossSite !== isSharedEnabled()) return true');
  });
});

describe('#415 slice 2: home page wires shared filter storage', () => {
  test('imports the shared helpers just like the game page', () => {
    expect(homeSrc).toMatch(/import\s+\{[^}]*readSharedField[^}]*writeShared[^}]*clearShared[^}]*isEnabled[^}]*\}\s+from\s+'\.\.\/\.\.\/shared\/filters-shared\.js/);
  });

  test('_writeSharedIfEnabled mirrors tier + source + store as arrays', () => {
    const idx = homeSrc.indexOf('function _writeSharedIfEnabled');
    expect(idx).toBeGreaterThan(0);
    const slice = homeSrc.slice(idx, idx + 400);
    expect(slice).toContain('writeShared({');
    expect(slice).toContain('rating: [...tierSel]');
    expect(slice).toContain('source: [...sourceSel]');
    expect(slice).toContain('store:  [...storeSel]');
    // Non-checked path clears the snapshot
    expect(slice).toContain('clearShared()');
  });

  test('load path fills tier / source / store from shared when the per-page snapshot did not', () => {
    // The gap-fill block runs only when isSharedEnabled() is true and the
    // corresponding set is empty. Make sure all three sets are considered.
    expect(homeSrc).toContain("if (isSharedEnabled()) {");
    expect(homeSrc).toContain("if (!tierSel.size)");
    expect(homeSrc).toContain("if (!sourceSel.size)");
    expect(homeSrc).toContain("if (!storeSel.size)");
    expect(homeSrc).toContain("readSharedField('rating')");
    expect(homeSrc).toContain("readSharedField('source')");
    expect(homeSrc).toContain("readSharedField('store')");
  });

  test('checkbox HTML is present with the same class + label as the game page', () => {
    expect(homeSrc).toContain('id="home-filter-share"');
    expect(homeSrc).toContain('Apply across the site');
    expect(homeSrc).toContain('filter-share-toggle');
  });

  test('_saveFiltersIfEnabled propagates to shared storage when the box is on', () => {
    const idx = homeSrc.indexOf('function _saveFiltersIfEnabled');
    expect(idx).toBeGreaterThan(0);
    const slice = homeSrc.slice(idx, idx + 400);
    expect(slice).toContain("document.getElementById('home-filter-share')?.checked");
    expect(slice).toContain('_writeSharedIfEnabled()');
  });

  test('unchecking the persist toggle drops the shared key too', () => {
    // The old click handler wrote to FILTERS_KEY only. Slice 2 must also
    // wipe the shared snapshot when persist is turned off entirely.
    const idx = homeSrc.indexOf("document.getElementById('home-filter-persist')?.addEventListener('click'");
    expect(idx).toBeGreaterThan(0);
    const slice = homeSrc.slice(idx, idx + 500);
    expect(slice).toContain('clearShared()');
  });
});

describe('#415 slice 2: CSS ships the share-toggle styling', () => {
  test('filter-share-toggle base class is defined with the muted-inline layout', () => {
    expect(reportsCss).toContain('.filter-share-toggle');
    expect(reportsCss).toMatch(/\.filter-share-toggle\s*\{[^}]*display:\s*inline-flex/);
    expect(reportsCss).toMatch(/\.filter-share-toggle\s+input\s*\{[^}]*accent-color:\s*var\(--accent\)/);
  });
});
