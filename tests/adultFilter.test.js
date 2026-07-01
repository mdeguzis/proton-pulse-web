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
