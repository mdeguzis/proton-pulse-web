/**
 * Tests for computeLibraryTierCounts in js/app/components/home-library-chart.js.
 * The aggregation is a pure function so it's straightforward to lock down (#199).
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

function loadSrc(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(/^import\s.*$/gm, '')
    .replace(/^export\s+(async\s+)?(function|const|let|var|class)\s/gm, '$1$2 ')
    .replace(/^export\s+\{[^}]*\}\s*;?\s*$/gm, '');
}

function makeCtx() {
  const ctx = vm.createContext({ console });
  vm.runInContext(loadSrc('js/app/components/home-library-chart.js'), ctx);
  return ctx;
}

const INDEX = [
  [10,  'A', 'platinum', 5, 1, 'steam'],
  [20,  'B', 'gold',     3, 0, 'steam'],
  [30,  'C', 'silver',   1, 0, 'steam'],
  [40,  'D', 'bronze',   0, 0, 'steam'],
  [50,  'E', 'borked',   0, 0, 'steam'],
  [60,  'F', 'pending',  0, 0, 'steam'],
  [70,  'G', '',         0, 0, 'gog'],  // no tier -> unrated
  [80,  'H', 'gold',     0, 0, 'steam'],
];

describe('computeLibraryTierCounts', () => {
  test('empty appids returns all zeros', () => {
    const ctx = makeCtx();
    const counts = ctx.computeLibraryTierCounts(new Set(), INDEX);
    expect(counts).toEqual({ platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0, pending: 0, unrated: 0 });
  });

  test('null inputs are safe', () => {
    const ctx = makeCtx();
    expect(ctx.computeLibraryTierCounts(null, INDEX)).toBeTruthy();
    expect(ctx.computeLibraryTierCounts(new Set([10]), null)).toBeTruthy();
  });

  test('aggregates tier counts and ignores appids not in the index', () => {
    const ctx = makeCtx();
    const owned = new Set([10, 20, 80, 999]);
    const counts = ctx.computeLibraryTierCounts(owned, INDEX);
    expect(counts.platinum).toBe(1);
    expect(counts.gold).toBe(2);
    expect(counts.silver).toBe(0);
    expect(counts.bronze).toBe(0);
    expect(counts.borked).toBe(0);
  });

  test('routes empty tier strings into the unrated bucket', () => {
    const ctx = makeCtx();
    const counts = ctx.computeLibraryTierCounts(new Set([70]), INDEX);
    expect(counts.unrated).toBe(1);
  });

  test('respects the pending tier column', () => {
    const ctx = makeCtx();
    const counts = ctx.computeLibraryTierCounts(new Set([60]), INDEX);
    expect(counts.pending).toBe(1);
  });
});
