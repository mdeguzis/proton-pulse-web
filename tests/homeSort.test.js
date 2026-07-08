/**
 * Home-page sort expansion (screenshots from ProtonDB /explore comparison).
 * Pins the pure sort helper + the dropdown option list so future edits
 * don't silently break parity between the UI select and the backing logic.
 */
const fs = require('fs');
const path = require('path');
const HOME = fs.readFileSync(path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'), 'utf8');

let sortReports, buildReleaseYearMap;
beforeAll(async () => {
  const mod = await import(path.join(__dirname, '..', 'js', 'app', 'lib', 'home-sort.js'));
  ({ sortReports, buildReleaseYearMap } = mod);
});

describe('home sort dropdown options', () => {
  test('exposes the seven sorts: Recent / Rating / Borked / Reported / Release desc + asc / Alpha', () => {
    // Every option value must appear as a switch branch in the sort helper too.
    for (const value of ['recent', 'best', 'worst', 'count', 'release_desc', 'release_asc', 'alpha']) {
      expect(HOME).toContain(`value="${value}"`);
    }
  });

  test('labels match the ProtonDB /explore vocabulary users are used to', () => {
    expect(HOME).toContain('>ProtonDB Rating</option>');
    expect(HOME).toContain('>Most Borked</option>');
    expect(HOME).toContain('>Release Date (newest)</option>');
    expect(HOME).toContain('>Release Date (oldest)</option>');
    expect(HOME).toContain('>Alphabetical (A-Z)</option>');
  });
});

describe('sortReports helper', () => {
  const REPORTS = [
    { appId: '1', title: 'Alpha Game',   tier: 'gold',     lastReportDate: '2026-03-01', protondbCount: 10, pulseCount: 0 },
    { appId: '2', title: 'zephyr trial', tier: 'platinum', lastReportDate: '2025-11-01', protondbCount: 5,  pulseCount: 0 },
    { appId: '3', title: 'Borked Beast', tier: 'borked',   lastReportDate: '2026-06-01', protondbCount: 100,pulseCount: 0 },
    { appId: '4', title: 'Unknown Year', tier: 'silver',   lastReportDate: '2025-01-01', protondbCount: 3,  pulseCount: 0 },
  ];
  const YEARS = new Map([['1', 2020], ['2', 2018], ['3', 2024]]); // #4 has no year
  const yearFn = (id) => YEARS.get(String(id)) ?? null;

  test('best puts platinum before gold and borked last', () => {
    const out = sortReports(REPORTS, 'best', yearFn).map((r) => r.appId);
    expect(out[0]).toBe('2');           // platinum
    expect(out[out.length - 1]).toBe('3'); // borked
  });

  test('worst puts borked first', () => {
    const out = sortReports(REPORTS, 'worst', yearFn).map((r) => r.appId);
    expect(out[0]).toBe('3');
  });

  test('count sorts by protondbCount + pulseCount descending', () => {
    const out = sortReports(REPORTS, 'count', yearFn).map((r) => r.appId);
    expect(out[0]).toBe('3');  // 100
    expect(out[1]).toBe('1');  // 10
  });

  test('release_desc puts newer years first and pushes missing-year entries to the end', () => {
    const out = sortReports(REPORTS, 'release_desc', yearFn).map((r) => r.appId);
    expect(out.slice(0, 3)).toEqual(['3', '1', '2']);  // 2024 > 2020 > 2018
    expect(out[3]).toBe('4');                          // no year -> last
  });

  test('release_asc puts oldest years first and pushes missing-year entries to the end', () => {
    const out = sortReports(REPORTS, 'release_asc', yearFn).map((r) => r.appId);
    expect(out.slice(0, 3)).toEqual(['2', '1', '3']);  // 2018 < 2020 < 2024
    expect(out[3]).toBe('4');
  });

  test('alpha is case-insensitive natural sort so "zephyr trial" sits after "Alpha Game"', () => {
    const out = sortReports(REPORTS, 'alpha', yearFn).map((r) => r.title);
    expect(out).toEqual([
      'Alpha Game', 'Borked Beast', 'Unknown Year', 'zephyr trial',
    ]);
  });

  test('does not mutate the input array (returns a fresh copy)', () => {
    const before = [...REPORTS];
    sortReports(REPORTS, 'best', yearFn);
    expect(REPORTS).toEqual(before);
  });

  test('unknown sort key returns the input order (no crash)', () => {
    const out = sortReports(REPORTS, 'nonsense', yearFn).map((r) => r.appId);
    expect(out).toEqual(REPORTS.map((r) => r.appId));
  });
});

describe('buildReleaseYearMap', () => {
  test('reads column 6 into an appId->year Map', () => {
    const idx = [
      ['1', 'A', 'gold',     10, 0, 'steam', 2020],
      ['2', 'B', 'platinum', 5,  0, 'steam', 2018],
      ['3', 'C', 'borked',   1,  0, 'steam', 2024, false, false, null, ''],
    ];
    const m = buildReleaseYearMap(idx);
    expect(m.get('1')).toBe(2020);
    expect(m.get('2')).toBe(2018);
    expect(m.get('3')).toBe(2024);
  });

  test('skips rows with missing or non-numeric year (stays null in the lookup)', () => {
    const idx = [
      ['1', 'A', 'gold', 10, 0, 'steam'],                // no year column
      ['2', 'B', 'gold', 10, 0, 'steam', null],
      ['3', 'C', 'gold', 10, 0, 'steam', 'bogus'],
    ];
    const m = buildReleaseYearMap(idx);
    expect(m.size).toBe(0);
  });

  test('tolerates non-array input without throwing', () => {
    expect(buildReleaseYearMap(null).size).toBe(0);
    expect(buildReleaseYearMap(undefined).size).toBe(0);
    expect(buildReleaseYearMap('nope').size).toBe(0);
  });
});

describe('home.js integration hooks', () => {
  test('imports the pure helpers', () => {
    expect(HOME).toContain("from '../lib/home-sort.js");
    expect(HOME).toContain('sortReports as _sortHelper');
    expect(HOME).toContain('buildReleaseYearMap as _buildReleaseYearMapPure');
  });

  test('resets + rebuilds the release-year map on every home render', () => {
    // Two call sites: the initial renderHomePage flow and the secondary
    // renderer that fires when a section reloads.
    const resets = HOME.match(/_releaseYearByAppId = null/g) || [];
    expect(resets.length).toBeGreaterThanOrEqual(2);
    const builds = HOME.match(/_buildReleaseYearMap\(\)/g) || [];
    expect(builds.length).toBeGreaterThanOrEqual(2);
  });
});
