/**
 * Deck Verified filter tests (#266 Phase 2).
 *
 * Covers:
 *  1. The new loadDeckStatusMap() export in js/app/api/deck-status.js.
 *  2. The _filterByDeck helper and its wire-up in home.js source.
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

// ---------- Part 1: loadDeckStatusMap export ---------------------------

function loadDeckApiModule({ fetchImpl } = {}) {
  return loadEsm(['js/app/api/deck-status.js'], {
    fetch: fetchImpl || (() => Promise.resolve({ ok: false })),
    // dataUrl is imported from ../../lib/data-url.js; the vm loader strips
    // imports, so we inject a matching stub that just echoes the file name.
    dataUrl: (name) => Promise.resolve(name),
    window: { SUPABASE_URL: '' },
    console: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
  });
}

describe('loadDeckStatusMap', () => {
  test('returns the parsed deck-status.json map', async () => {
    const map = { '570': { status: 'verified', criteria: [true, true, true, true] } };
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(map),
    });
    const { loadDeckStatusMap } = loadDeckApiModule({ fetchImpl });
    const got = await loadDeckStatusMap();
    expect(got['570']).toEqual(map['570']);
  });

  test('caches the fetch so a second call does not refetch', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ '440': { status: 'playable', criteria: null } }),
    });
    const { loadDeckStatusMap } = loadDeckApiModule({ fetchImpl });
    await loadDeckStatusMap();
    await loadDeckStatusMap();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns an empty map when the fetch is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const { loadDeckStatusMap } = loadDeckApiModule({ fetchImpl });
    const got = await loadDeckStatusMap();
    expect(typeof got).toBe('object');
    expect(Object.keys(got).length).toBe(0);
  });

  test('returns an empty map when the fetch throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('net'));
    const { loadDeckStatusMap } = loadDeckApiModule({ fetchImpl });
    const got = await loadDeckStatusMap();
    expect(typeof got).toBe('object');
    expect(Object.keys(got).length).toBe(0);
  });
});


// ---------- Part 2: home.js filter chain integration --------------------

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8',
);

describe('home.js wires the Deck Verified filter (#266 Phase 2)', () => {
  test('imports loadDeckStatusMap from api/deck-status.js', () => {
    expect(HOME_SRC).toMatch(/from '\.\.\/api\/deck-status\.js/);
    expect(HOME_SRC).toContain('loadDeckStatusMap');
  });

  test('defines _filterByDeck with the correct short-circuit shape', () => {
    expect(HOME_SRC).toContain('function _filterByDeck(reports, sel, deckStatusMap)');
    // 'all' selection => pass-through.
    expect(HOME_SRC).toMatch(/_filterByDeck[\s\S]{0,300}sel\.has\('all'\)/);
    // Non-Steam ids always pass through.
    expect(HOME_SRC).toMatch(/_filterByDeck[\s\S]{0,400}\/\^\\d\+\$\//);
  });

  test('both filter chains call _filterByDeck', () => {
    const chainMatches = HOME_SRC.match(/_filterByDeck\(_filterByWishlist/g) || [];
    expect(chainMatches.length).toBeGreaterThanOrEqual(2);
  });

  test('markup has a #home-deck-checks group with the four verdict chips', () => {
    expect(HOME_SRC).toContain('id="home-deck-checks"');
    expect(HOME_SRC).toContain('data-value="verified"');
    expect(HOME_SRC).toContain('data-value="playable"');
    expect(HOME_SRC).toContain('data-value="unsupported"');
    expect(HOME_SRC).toContain('data-value="unknown"');
    expect(HOME_SRC).toContain('>Verified<');
    expect(HOME_SRC).toContain('>Playable<');
    expect(HOME_SRC).toContain('>Unsupported<');
    expect(HOME_SRC).toContain('>Unknown<');
  });

  test('deck selection lazy-loads the deck-status map on first non-"all" activation', () => {
    // Same shape as the wishlist on-change: fetch the map when any non-'all'
    // chip is first selected. Any selection needs the map to filter properly.
    expect(HOME_SRC).toMatch(/deckSel = sel;[\s\S]{0,400}loadDeckStatusMap/);
  });

  test('deckSel is included in save + restore + clear + badge count', () => {
    expect(HOME_SRC).toContain('deck: [...deckSel]');
    expect(HOME_SRC).toContain('deckSel = new Set(saved.deck || [])');
    expect(HOME_SRC).toContain('deckSel = new Set();');
    expect(HOME_SRC).toMatch(/wishlistSel\.size \+ deckSel\.size/);
  });
});


// ---------- Part 3: _filterByDeck behaviour (extracted from source) -----

// Recreate the helper from source so the behavioural tests actually exercise
// the logic in home.js -- not a hand-written stand-in that could drift.
function extractFilterByDeck() {
  const match = HOME_SRC.match(
    /function _filterByDeck\(reports, sel, deckStatusMap\) \{[\s\S]*?\n\}\n/,
  );
  if (!match) throw new Error('could not locate _filterByDeck in home.js');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${match[0]}\nreturn _filterByDeck;`);
  return factory();
}

describe('_filterByDeck behaviour', () => {
  const _filterByDeck = extractFilterByDeck();

  const reports = [
    { appId: 570,  title: 'Dota 2' },      // verified
    { appId: 440,  title: 'TF2' },         // playable
    { appId: 730,  title: 'CS2' },         // unsupported
    { appId: 9999, title: 'Uncharted' },   // no entry -> unknown
    { appId: 'gog:1234', title: 'Baldurs' }, // non-Steam id
  ];

  const map = {
    '570': { status: 'verified',    criteria: null },
    '440': { status: 'playable',    criteria: null },
    '730': { status: 'unsupported', criteria: null },
  };

  test('empty selection is pass-through', () => {
    const out = _filterByDeck(reports, new Set(), map);
    expect(out).toEqual(reports);
  });

  test('"all" selection is pass-through', () => {
    const out = _filterByDeck(reports, new Set(['all']), map);
    expect(out).toEqual(reports);
  });

  test('verified only returns Verified games', () => {
    const out = _filterByDeck(reports, new Set(['verified']), map);
    // Non-Steam ids always pass through, so the gog: entry is included.
    expect(out.map(r => r.appId).sort()).toEqual([570, 'gog:1234'].sort());
  });

  test('unknown catches games with no map entry', () => {
    const out = _filterByDeck(reports, new Set(['unknown']), map);
    expect(out.map(r => r.appId).sort()).toEqual([9999, 'gog:1234'].sort());
  });

  test('multi-select combines statuses', () => {
    const out = _filterByDeck(reports, new Set(['verified', 'playable']), map);
    expect(out.map(r => r.appId).sort()).toEqual([440, 570, 'gog:1234'].sort());
  });

  test('unsupported filter excludes verified/playable/unknown', () => {
    const out = _filterByDeck(reports, new Set(['unsupported']), map);
    expect(out.map(r => r.appId).sort()).toEqual([730, 'gog:1234'].sort());
  });

  test('null map treats everything as unknown', () => {
    const out = _filterByDeck(reports, new Set(['unknown']), null);
    expect(out.map(r => r.appId).sort()).toEqual([440, 570, 730, 9999, 'gog:1234'].sort());
  });
});
