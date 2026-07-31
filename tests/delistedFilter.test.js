/**
 * Client-side gate for delisted games (#434).
 * Mirrors the adult-filter contract: default hide, opt in via
 * pp:show-delisted=on. Column 7 of search-index rows holds the flag.
 */
const {
  showDelistedAllowed,
  filterDelisted,
  isDelistedEntry,
  filterDelistedEntries,
  countHiddenDelisted,
  DELISTED_COL_SEARCH_INDEX,
} = require('../js/lib/delisted-filter.js');

describe('delisted-filter', () => {
  let store;
  beforeAll(() => {
    store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { store = {}; },
    };
  });
  beforeEach(() => { Object.keys(store).forEach(k => delete store[k]); });

  test('showDelistedAllowed defaults to false when pref is missing', () => {
    expect(showDelistedAllowed()).toBe(false);
  });

  test('showDelistedAllowed is true only when pp:show-delisted is exactly "on"', () => {
    localStorage.setItem('pp:show-delisted', 'on');
    expect(showDelistedAllowed()).toBe(true);
    localStorage.setItem('pp:show-delisted', 'off');
    expect(showDelistedAllowed()).toBe(false);
    localStorage.setItem('pp:show-delisted', 'true');
    expect(showDelistedAllowed()).toBe(false);
  });

  test('filterDelisted hides delisted=true rows when the pref is off', () => {
    const rows = [
      { title: 'Live Game', delisted: false },
      { title: 'Removed Game', delisted: true },
      { title: 'Old Row' }, // no delisted field
    ];
    expect(filterDelisted(rows).map(r => r.title))
      .toEqual(['Live Game', 'Old Row']);
  });

  test('filterDelisted passes rows through when the pref is on', () => {
    localStorage.setItem('pp:show-delisted', 'on');
    const rows = [
      { title: 'Live Game', delisted: false },
      { title: 'Removed Game', delisted: true },
    ];
    expect(filterDelisted(rows).map(r => r.title))
      .toEqual(['Live Game', 'Removed Game']);
  });

  test('filterDelisted treats rows without the delisted field as safe', () => {
    // Pre-flag data files must not go blank -- rows without the field
    // stay visible until the next pipeline run repopulates them.
    const rows = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
    expect(filterDelisted(rows)).toEqual(rows);
  });

  test('filterDelisted tolerates null / undefined without throwing', () => {
    const rows = [null, undefined, { title: 'ok', delisted: false }];
    expect(filterDelisted(rows)).toEqual(rows);
  });
});

describe('isDelistedEntry / filterDelistedEntries / countHiddenDelisted', () => {
  const mk = (delisted) => ['1', 'T', '', 0, 0, 'steam', null, delisted];

  test('flags only rows with delisted === true at the delisted column', () => {
    expect(isDelistedEntry(mk(true))).toBe(true);
    expect(isDelistedEntry(mk(false))).toBe(false);
    expect(isDelistedEntry(mk(null))).toBe(false);
    expect(isDelistedEntry(['1', 'short'])).toBe(false);
    expect(isDelistedEntry('not-an-array')).toBe(false);
  });

  test('filterDelistedEntries drops delisted rows when pref is off', () => {
    global.localStorage = { getItem: () => 'off' };
    const rows = [mk(true), mk(false), mk(null)];
    expect(filterDelistedEntries(rows)).toHaveLength(2);
  });

  test('filterDelistedEntries passes everything through when pref is on', () => {
    global.localStorage = { getItem: () => 'on' };
    const rows = [mk(true), mk(false)];
    expect(filterDelistedEntries(rows)).toHaveLength(2);
  });

  test('countHiddenDelisted returns the count of hidden rows when pref off', () => {
    global.localStorage = { getItem: () => 'off' };
    const rows = [mk(true), mk(true), mk(false), mk(null)];
    expect(countHiddenDelisted(rows)).toBe(2);
  });

  test('countHiddenDelisted returns 0 when pref is on', () => {
    global.localStorage = { getItem: () => 'on' };
    const rows = [mk(true), mk(true), mk(false)];
    expect(countHiddenDelisted(rows)).toBe(0);
  });

  test('honors a custom column index', () => {
    global.localStorage = { getItem: () => 'off' };
    const row = ['1', 'T', true];
    expect(isDelistedEntry(row, 2)).toBe(true);
    expect(filterDelistedEntries([row], 2)).toHaveLength(0);
  });

  test('column constant matches the pipeline row shape', () => {
    expect(DELISTED_COL_SEARCH_INDEX).toBe(7);
  });
});

describe('topbar autocomplete delisted gate (#434)', () => {
  const fs = require('fs');
  const path = require('path');
  const TOPBAR = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'topbar.js'), 'utf8');

  test('topbar reads pp:show-delisted locally and forwards to search API', () => {
    // #434: search moved to the search-games edge fn. Topbar still reads
    // the pref locally so it can forward the include_delisted flag; the
    // server enforces the filter against the Postgres index.
    expect(TOPBAR).toContain("localStorage.getItem('pp:show-delisted') === 'on'");
    expect(TOPBAR).toContain('_showDelistedAllowed()');
    expect(TOPBAR).toContain("url.searchParams.set('include_delisted', 'true')");
  });
});
