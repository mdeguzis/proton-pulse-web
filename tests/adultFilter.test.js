/**
 * Client-side gate for adult-flagged games. Rows come from the pipeline
 * with adult: true when Steam content descriptors 1, 4, or 5 apply.
 * The gate defaults to hiding those rows; users can opt in via the site
 * options "Show adult games" toggle (pp:show-adult=on).
 */
const { showAdultAllowed, filterAdult } = require('../js/lib/adult-filter.js');

describe('adult-filter', () => {
  let store;
  beforeAll(() => {
    store = {};
    global.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { store = {}; global.localStorage._store = store; },
    };
  });
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
  });

  test('showAdultAllowed defaults to false when pref is missing', () => {
    expect(showAdultAllowed()).toBe(false);
  });

  test('showAdultAllowed is true only when pp:show-adult is exactly "on"', () => {
    localStorage.setItem('pp:show-adult', 'on');
    expect(showAdultAllowed()).toBe(true);
    localStorage.setItem('pp:show-adult', 'off');
    expect(showAdultAllowed()).toBe(false);
    localStorage.setItem('pp:show-adult', 'true');
    expect(showAdultAllowed()).toBe(false);
  });

  test('filterAdult hides adult=true rows when the pref is off', () => {
    const rows = [
      { title: 'Regular Game', adult: false },
      { title: 'Naughty Chat', adult: true },
      { title: 'Old Data Row' }, // no adult field
    ];
    expect(filterAdult(rows).map(r => r.title))
      .toEqual(['Regular Game', 'Old Data Row']);
  });

  test('filterAdult passes rows through when the pref is on', () => {
    localStorage.setItem('pp:show-adult', 'on');
    const rows = [
      { title: 'Regular Game', adult: false },
      { title: 'Naughty Chat', adult: true },
    ];
    expect(filterAdult(rows).map(r => r.title))
      .toEqual(['Regular Game', 'Naughty Chat']);
  });

  test('filterAdult treats rows without the adult field as safe (backwards compat)', () => {
    // Older data files (pre-adult-flag) had no adult key. Those rows
    // must not be filtered -- if they were, the whole grid would go
    // empty until the next pipeline run repopulates the field.
    const rows = [
      { title: 'A' }, { title: 'B' }, { title: 'C' },
    ];
    expect(filterAdult(rows)).toEqual(rows);
  });

  test('filterAdult tolerates null / undefined entries without throwing', () => {
    const rows = [null, undefined, { title: 'ok', adult: false }];
    // null/undefined pass through the safety branch (r.adult !== true).
    expect(filterAdult(rows)).toEqual(rows);
  });
});

describe('topbar autocomplete adult gate', () => {
  const fs = require('fs');
  const path = require('path');
  const TOPBAR = fs.readFileSync(path.join(__dirname, '..', 'js', 'lib', 'topbar.js'), 'utf8');

  test('match() skips adult-flagged rows (column 8) unless the pref is on', () => {
    // Inlined mirror of adult-filter.js since topbar is a classic script.
    expect(TOPBAR).toContain("localStorage.getItem('pp:show-adult') === 'on'");
    expect(TOPBAR).toContain('const showAdult = _showAdultAllowed()');
    expect(TOPBAR).toContain('if (!showAdult && row[8] === true) continue');
  });
});


// ---------- array-row variants (search-index shape) ----------------------
const { isAdultEntry, filterAdultEntries, ADULT_COL_SEARCH_INDEX } = require('../js/lib/adult-filter.js');

describe('isAdultEntry / filterAdultEntries', () => {
  const mk = (adult) => ['1', 'T', '', 0, 0, 'steam', null, null, adult];

  test('flags only rows with adult === true at the adult column', () => {
    expect(isAdultEntry(mk(true))).toBe(true);
    expect(isAdultEntry(mk(false))).toBe(false);
    expect(isAdultEntry(mk(null))).toBe(false);
    expect(isAdultEntry(['1', 'short-row'])).toBe(false);
    expect(isAdultEntry('not-an-array')).toBe(false);
  });

  test('filterAdultEntries drops adult rows when the pref is off', () => {
    global.localStorage = { getItem: () => 'off' };
    const rows = [mk(true), mk(false), mk(null)];
    expect(filterAdultEntries(rows)).toHaveLength(2);
  });

  test('filterAdultEntries passes everything through when the pref is on', () => {
    global.localStorage = { getItem: () => 'on' };
    const rows = [mk(true), mk(false)];
    expect(filterAdultEntries(rows)).toHaveLength(2);
  });

  test('honors a custom column index', () => {
    global.localStorage = { getItem: () => 'off' };
    const row = ['1', 'T', true];
    expect(isAdultEntry(row, 2)).toBe(true);
    expect(filterAdultEntries([row], 2)).toHaveLength(0);
  });

  test('column constant matches the pipeline row shape', () => {
    expect(ADULT_COL_SEARCH_INDEX).toBe(8);
  });
});
