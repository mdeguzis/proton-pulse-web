/**
 * #N/A: proves the library-view total lines up with the user's actual
 * owned game count -- a real Steam library has games missing from both
 * recent-reports and search-index (never got a ProtonDB report), and
 * they must still count.
 */
const path = require('path');

let synthesizeMyLibrary;
beforeAll(async () => {
  const mod = await import(path.join(__dirname, '..', 'js', 'app', 'lib', 'my-library-synth.js'));
  ({ synthesizeMyLibrary } = mod);
});

describe('synthesizeMyLibrary', () => {
  test('empty library returns empty output', () => {
    const out = synthesizeMyLibrary(new Set(), [], []);
    expect(out).toEqual({ rows: [], fromRecentReports: 0, fromSearchIndex: 0, bareStubs: 0 });
  });

  test('null library returns empty output (no crash)', () => {
    const out = synthesizeMyLibrary(null, [{ appId: '1' }], [[1, 't', 'gold', 0, 0, 'steam']]);
    expect(out.rows).toEqual([]);
  });

  test('rows from recent-reports come first and keep their fields', () => {
    const owned = new Set([1, 2]);
    const recent = [
      { appId: '1', title: 'One',    tier: 'gold',     protondbCount: 10, pulseCount: 2, appType: 'steam', lastReportDate: '2026-01-01' },
      { appId: '9', title: 'Nine',   tier: 'platinum', protondbCount: 3,  pulseCount: 0, appType: 'steam', lastReportDate: '2026-01-02' }, // not owned
    ];
    const idx = [
      [2, 'Two', 'silver', 5, 1, 'steam'],
    ];
    const out = synthesizeMyLibrary(owned, recent, idx);
    expect(out.fromRecentReports).toBe(1);
    expect(out.fromSearchIndex).toBe(1);
    expect(out.bareStubs).toBe(0);
    expect(out.rows[0].appId).toBe('1');
    expect(out.rows[0].lastReportDate).toBe('2026-01-01');
    expect(out.rows[1].appId).toBe('2');
    expect(out.rows[1].tier).toBe('silver');
  });

  test('search-index rows are added only when owned and not already covered', () => {
    const owned = new Set([1, 2, 3]);
    const recent = [{ appId: '1', title: 'One' }];
    const idx = [
      [1, 'One-idx',   'gold',    5, 0, 'steam'], // skip -- already in recent
      [2, 'Two',       'silver',  2, 0, 'steam'],
      [4, 'Four',      'bronze',  1, 0, 'steam'], // skip -- not owned
    ];
    const out = synthesizeMyLibrary(owned, recent, idx);
    expect(out.fromSearchIndex).toBe(1);
    expect(out.rows.find((r) => r.appId === '2').title).toBe('Two');
  });

  test('bare stubs emitted for owned appIds missing from recent AND search-index', () => {
    const owned = new Set([1, 2, 3]);
    const recent = [{ appId: '1', title: 'One' }];
    const idx = [[2, 'Two', 'silver', 2, 0, 'steam']];
    const out = synthesizeMyLibrary(owned, recent, idx);
    expect(out.bareStubs).toBe(1);
    const stub = out.rows.find((r) => r.appId === '3');
    expect(stub).toBeDefined();
    expect(stub.title).toBe('App 3');
    expect(stub.tier).toBe('pending');
  });

  test('final row count equals owned library size (nothing lost, nothing duplicated)', () => {
    // 714-vs-677 scenario: real library with a mix of coverage sources.
    const owned = new Set(Array.from({ length: 714 }, (_, i) => i + 1));
    const recent = Array.from({ length: 50 }, (_, i) => ({ appId: String(i + 1), title: `Recent ${i + 1}` }));
    // search-index has 627 of the remaining 664 owned games (rest are unreported).
    const idx = Array.from({ length: 627 }, (_, i) => [i + 51, `Idx ${i + 51}`, 'gold', 1, 0, 'steam']);
    const out = synthesizeMyLibrary(owned, recent, idx);
    expect(out.fromRecentReports).toBe(50);
    expect(out.fromSearchIndex).toBe(627);
    expect(out.bareStubs).toBe(37);
    expect(out.rows).toHaveLength(714);
    // No duplicate appIds.
    expect(new Set(out.rows.map((r) => r.appId)).size).toBe(714);
  });

  test('malformed search-index rows are skipped without throwing', () => {
    const owned = new Set([1, 2]);
    const out = synthesizeMyLibrary(owned, [], [
      null,
      undefined,
      [1],
      [2, 'Two', 'gold', 0, 0, 'steam'],
    ]);
    expect(out.fromSearchIndex).toBe(1);
    expect(out.bareStubs).toBe(1); // appId 1 becomes a stub
  });
});
