/**
 * Behavioral tests for the pagination preferences module (#253).
 *
 * The module reads/writes a single JSON blob under localStorage to keep
 * the three settings (mobile size, desktop size, auto-load) coherent,
 * and falls back to defaults when the blob is missing or malformed.
 */
const { loadEsm } = require('./_esm-vm.js');

function loadModule({ storage = new Map(), width = 1400 } = {}) {
  const ls = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const ctx = loadEsm(['js/lib/pagination-prefs.js'], {
    localStorage: ls,
    window: { innerWidth: width },
  });
  return { ...ctx, storage };
}

describe('getPageSizePref defaults', () => {
  test('returns defaults when nothing is stored', () => {
    const { getPageSizePref, DEFAULT_MOBILE_TILES_PER_PAGE, DEFAULT_DESKTOP_TILES_PER_PAGE, DEFAULT_AUTO_LOAD } = loadModule();
    expect(getPageSizePref()).toEqual({
      mobile: DEFAULT_MOBILE_TILES_PER_PAGE,
      desktop: DEFAULT_DESKTOP_TILES_PER_PAGE,
      autoLoad: DEFAULT_AUTO_LOAD,
    });
  });

  test('returns defaults when the stored blob is not valid JSON', () => {
    const storage = new Map([['pp-page-size', '{ this is not JSON']]);
    const { getPageSizePref, DEFAULT_MOBILE_TILES_PER_PAGE } = loadModule({ storage });
    expect(getPageSizePref().mobile).toBe(DEFAULT_MOBILE_TILES_PER_PAGE);
  });

  test('falls back on any non-positive number so an accidental 0 does not disable pagination', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ mobile: 0, desktop: -5, autoLoad: true })]]);
    const { getPageSizePref, DEFAULT_MOBILE_TILES_PER_PAGE, DEFAULT_DESKTOP_TILES_PER_PAGE } = loadModule({ storage });
    const p = getPageSizePref();
    expect(p.mobile).toBe(DEFAULT_MOBILE_TILES_PER_PAGE);
    expect(p.desktop).toBe(DEFAULT_DESKTOP_TILES_PER_PAGE);
    expect(p.autoLoad).toBe(true);
  });

  test('floors non-integer values so partial pages never happen', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ mobile: 22.7, desktop: 55.9 })]]);
    const { getPageSizePref } = loadModule({ storage });
    const p = getPageSizePref();
    expect(p.mobile).toBe(22);
    expect(p.desktop).toBe(55);
  });
});

describe('setPageSizePref persistence', () => {
  test('a full patch writes all three fields back', () => {
    const { setPageSizePref, getPageSizePref, storage } = loadModule();
    setPageSizePref({ mobile: 15, desktop: 30, autoLoad: true });
    expect(getPageSizePref()).toEqual({ mobile: 15, desktop: 30, autoLoad: true });
    expect(storage.get('pp-page-size')).toBeDefined();
  });

  test('a partial patch merges with the current stored values', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ mobile: 12, desktop: 40, autoLoad: false })]]);
    const { setPageSizePref, getPageSizePref } = loadModule({ storage });
    setPageSizePref({ autoLoad: true });
    const p = getPageSizePref();
    expect(p.mobile).toBe(12);
    expect(p.desktop).toBe(40);
    expect(p.autoLoad).toBe(true);
  });

  test('an invalid value in a patch is ignored, keeping the previous value', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ mobile: 12, desktop: 40, autoLoad: false })]]);
    const { setPageSizePref, getPageSizePref } = loadModule({ storage });
    setPageSizePref({ mobile: -1 });
    expect(getPageSizePref().mobile).toBe(12);
  });
});

describe('getEffectivePageSize per viewport class', () => {
  test('returns mobile size when window is narrower than 1024', () => {
    const { getEffectivePageSize, DEFAULT_MOBILE_TILES_PER_PAGE } = loadModule({ width: 500 });
    expect(getEffectivePageSize()).toBe(DEFAULT_MOBILE_TILES_PER_PAGE);
  });

  test('returns desktop size when window is 1024 or wider', () => {
    const { getEffectivePageSize, DEFAULT_DESKTOP_TILES_PER_PAGE } = loadModule({ width: 1400 });
    expect(getEffectivePageSize()).toBe(DEFAULT_DESKTOP_TILES_PER_PAGE);
  });

  test('respects an override for the current viewport class', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ mobile: 15, desktop: 60 })]]);
    const { getEffectivePageSize } = loadModule({ storage, width: 500 });
    expect(getEffectivePageSize()).toBe(15);
  });
});

describe('isAutoLoadEnabled', () => {
  test('defaults to false', () => {
    const { isAutoLoadEnabled } = loadModule();
    expect(isAutoLoadEnabled()).toBe(false);
  });

  test('reads the stored autoLoad flag', () => {
    const storage = new Map([['pp-page-size', JSON.stringify({ autoLoad: true })]]);
    const { isAutoLoadEnabled } = loadModule({ storage });
    expect(isAutoLoadEnabled()).toBe(true);
  });
});
