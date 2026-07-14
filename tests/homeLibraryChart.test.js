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

describe('computeDeviceStatusCounts (Machine + SteamOS, #273)', () => {
  const MAP = {
    '10': { status: 'verified', machine: 'verified', steamos: 'compatible' },
    '20': { status: 'playable', machine: 'playable', steamos: 'compatible' },
    '30': { status: 'unsupported', machine: 'unsupported', steamos: 'unsupported' },
    '40': { status: 'verified' }, // machine/steamos absent -> unknown
  };

  test('machine field tallies verified/playable/unsupported, missing -> unknown', () => {
    const ctx = makeCtx();
    const c = ctx.computeDeviceStatusCounts(new Set([10, 20, 30, 40]), MAP, 'machine', ['verified', 'playable', 'unsupported', 'unknown']);
    expect(c).toEqual({ verified: 1, playable: 1, unsupported: 1, unknown: 1 });
  });

  test('steamos field uses the compatible bucket, missing -> unknown', () => {
    const ctx = makeCtx();
    const c = ctx.computeDeviceStatusCounts(new Set([10, 20, 30, 40]), MAP, 'steamos', ['compatible', 'unsupported', 'unknown']);
    expect(c).toEqual({ compatible: 2, unsupported: 1, unknown: 1 });
  });

  test('computeDeckStatusCounts still reads the legacy status field', () => {
    const ctx = makeCtx();
    const c = ctx.computeDeckStatusCounts(new Set([10, 20, 30, 40]), MAP);
    expect(c).toEqual({ verified: 2, playable: 1, unsupported: 1, unknown: 0 });
  });

  test('empty set returns all-zero buckets', () => {
    const ctx = makeCtx();
    const c = ctx.computeDeviceStatusCounts(new Set(), MAP, 'machine', ['verified', 'playable', 'unsupported', 'unknown']);
    expect(c).toEqual({ verified: 0, playable: 0, unsupported: 0, unknown: 0 });
  });
});

describe('_rowHref -- deep-link URLs for clickable chart rows (#290)', () => {
  test('library tier rows link to app.html with filter=mine, tier, and view', () => {
    const ctx = makeCtx();
    expect(ctx._rowHref('library', 'gold')).toBe('app.html?filter=mine&tier=gold&view=library');
    expect(ctx._rowHref('library', 'platinum')).toBe('app.html?filter=mine&tier=platinum&view=library');
    expect(ctx._rowHref('library', 'borked')).toBe('app.html?filter=mine&tier=borked&view=library');
  });

  test('wishlist tier rows switch the scope and view to wishlist', () => {
    const ctx = makeCtx();
    expect(ctx._rowHref('wishlist', 'gold')).toBe('app.html?filter=wishlist&tier=gold&view=wishlist');
    expect(ctx._rowHref('wishlist', 'silver')).toBe('app.html?filter=wishlist&tier=silver&view=wishlist');
  });

  test('device views encode status as deck/machine/steamos param and carry view=<device>', () => {
    const ctx = makeCtx();
    expect(ctx._rowHref('deck', 'verified')).toBe('app.html?filter=mine&deck=verified&view=deck');
    expect(ctx._rowHref('machine', 'playable')).toBe('app.html?filter=mine&machine=playable&view=machine');
    expect(ctx._rowHref('steamos', 'compatible')).toBe('app.html?filter=mine&steamos=compatible&view=steamos');
  });

  test('unknown device bucket returns null so the row is not clickable', () => {
    const ctx = makeCtx();
    expect(ctx._rowHref('deck', 'unknown')).toBeNull();
    expect(ctx._rowHref('machine', 'unknown')).toBeNull();
    expect(ctx._rowHref('steamos', 'unknown')).toBeNull();
  });
});
