/**
 * #242 anti-cheat filter on the home page: the bucket helpers in
 * js/app/lib/anti-cheat.js, _filterByAntiCheat in home.js, and the panel
 * wiring (chips, lazy map load, browse pool, save / restore / clear).
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const homeSrc = fs.readFileSync(path.join(__dirname, '..', 'js/app/components/home.js'), 'utf8');

const lib = loadEsm(['js/app/lib/anti-cheat.js'], {
  dataUrl: async (n) => n,
  esc: (s) => String(s),
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  console: { debug() {}, warn() {} },
});

describe('antiCheatFilterKey', () => {
  test.each([
    [{ status: 'supported', vendors: ['EAC'] }, 'works'],
    [{ status: 'running', vendors: [] }, 'works'],
    [{ status: 'broken', vendors: ['BattlEye'] }, 'blocked'],
    [{ status: 'denied', vendors: [] }, 'blocked'],
    [{ status: 'planned', vendors: ['EAC'] }, 'unknown'],
    [{ status: null, vendors: ['nProtect'] }, 'unknown'],
    [{ status: null, vendors: [] }, 'none'],
    [null, 'none'],
  ])('%j -> %s', (entry, key) => {
    expect(lib.antiCheatFilterKey(entry)).toBe(key);
  });

  test('exposes exactly the four keys the panel offers', () => {
    expect([...lib.ANTI_CHEAT_FILTER_KEYS]).toEqual(['works', 'blocked', 'unknown', 'none']);
    for (const key of lib.ANTI_CHEAT_FILTER_KEYS) {
      expect(homeSrc).toContain(`data-value="${key}"`);
    }
  });
});

describe('matchesAntiCheatFilter', () => {
  const blocked = { status: 'denied', vendors: ['EAC'] };
  test('empty selection or All passes everything', () => {
    expect(lib.matchesAntiCheatFilter(blocked, new Set())).toBe(true);
    expect(lib.matchesAntiCheatFilter(blocked, new Set(['all']))).toBe(true);
    expect(lib.matchesAntiCheatFilter(blocked, null)).toBe(true);
  });
  test('"hide blocked" is works + unknown + none', () => {
    const hideBlocked = new Set(['works', 'unknown', 'none']);
    expect(lib.matchesAntiCheatFilter(blocked, hideBlocked)).toBe(false);
    expect(lib.matchesAntiCheatFilter(null, hideBlocked)).toBe(true);
    expect(lib.matchesAntiCheatFilter({ status: 'supported' }, hideBlocked)).toBe(true);
  });
});

describe('antiCheatAppIdsMatching', () => {
  const map = {
    10: { status: 'supported' }, 20: { status: 'broken' }, 30: { status: 'denied' },
    40: { status: 'planned' }, 'gog:5': { status: 'supported' },
  };
  test('returns Steam appids in the selected buckets only', () => {
    expect([...lib.antiCheatAppIdsMatching(map, new Set(['blocked']))].sort()).toEqual(['20', '30']);
    expect([...lib.antiCheatAppIdsMatching(map, new Set(['works']))]).toEqual(['10']);
  });
  test('no selection, All, or no map returns nothing', () => {
    expect(lib.antiCheatAppIdsMatching(map, new Set())).toHaveLength(0);
    expect(lib.antiCheatAppIdsMatching(map, new Set(['all']))).toHaveLength(0);
    expect(lib.antiCheatAppIdsMatching(null, new Set(['works']))).toHaveLength(0);
  });
});

describe('_filterByAntiCheat (behavioral)', () => {
  const ctx = loadEsm(['js/app/components/home.js'], {
    matchesAntiCheatFilter: lib.matchesAntiCheatFilter,
  });
  const { _filterByAntiCheat } = ctx;
  const map = { 252490: { status: 'denied' }, 107410: { status: 'supported' } };
  const rows = [{ appId: '252490' }, { appId: 107410 }, { appId: '1245620' }, { appId: 'gog:111' }];
  const ids = (out) => out.map((r) => String(r.appId));

  test('no selection returns every row', () => {
    expect(_filterByAntiCheat(rows, new Set(), map)).toHaveLength(4);
  });
  test('a null map (not loaded or failed) filters nothing rather than emptying the grid', () => {
    expect(_filterByAntiCheat(rows, new Set(['works']), null)).toHaveLength(4);
  });
  test('Works on Linux keeps only supported/running games, numeric ids included', () => {
    expect(ids(_filterByAntiCheat(rows, new Set(['works']), map))).toEqual(['107410']);
  });
  test('Not listed covers unknown Steam games and non-Steam rows', () => {
    expect(ids(_filterByAntiCheat(rows, new Set(['none']), map))).toEqual(['1245620', 'gog:111']);
  });
  test('hiding blocked games drops only the denied one', () => {
    expect(ids(_filterByAntiCheat(rows, new Set(['works', 'unknown', 'none']), map)))
      .toEqual(['107410', '1245620', 'gog:111']);
  });
});

describe('home panel wiring', () => {
  test('anti-cheat chip group renders with All first', () => {
    expect(homeSrc).toContain('id="home-ac-checks"');
    expect(homeSrc).toContain('<span class="pg-filter-group-label">Anti-cheat</span>');
    expect(homeSrc).toMatch(/id="home-ac-checks"[\s\S]{0,400}data-value="all">All</);
  });
  test('runs in both the recent and popular filter chains', () => {
    expect(homeSrc.match(/_filterByAntiCheat\(_filterByVr\(/g)).toHaveLength(2);
    expect(homeSrc.match(/vrSel, vrMap\), acSel, acMap\)/g)).toHaveLength(2);
  });
  test('the map loads lazily on first chip use', () => {
    expect(homeSrc).toContain('if (needMap && !acMap) acMap = await loadAntiCheatMap();');
  });
  test('the browse pool is used only when Not listed is off, and VR wins when both are on', () => {
    expect(homeSrc).toContain("const _acBrowseActive = () => acSel.size > 0 && !acSel.has('all') && !acSel.has('none');");
    expect(homeSrc).toMatch(/vrFilterActive && _homeVrRows\.length\s*\?\s*_homeVrRows\s*:\s*_acBrowseActive\(\) && _homeAcRows\.length\s*\?\s*_homeAcRows/);
  });
  test('a failed browse logs and falls back to the chart', () => {
    expect(homeSrc).toContain("console.warn('[home] anti-cheat browse failed, filtering the chart instead'");
  });
  test('selection is saved, restored onto the chips, counted, and cleared', () => {
    expect(homeSrc).toContain('ac: [...acSel]');
    expect(homeSrc).toContain('acSel = new Set(saved.ac || [])');
    expect(homeSrc).toContain('_applyPillSelection(acGroup, saved.ac)');
    expect(homeSrc).toContain('vrSel.size + acSel.size');
    expect(homeSrc).toMatch(/vrGroup, acGroup\]\.forEach/);
    expect(homeSrc).toMatch(/vrSel = new Set\(\);\s*acSel = new Set\(\);/);
  });
});

describe('restored filters load their data before first render', () => {
  // Before this, a saved Deck / VR chip came back highlighted in the badge
  // count but filtered nothing until it was clicked again.
  test('saved VR chips are re-highlighted and the VR map + pool load', () => {
    expect(homeSrc).toContain('_applyPillSelection(vrGroup, saved.vr)');
    expect(homeSrc).toMatch(/if \(_active\(vrSel\)\) \{\s*if \(!vrMap\) vrMap = await loadVrIndex\(\)/);
  });
  test('saved device chips load the deck-status map, not only URL-seeded ones', () => {
    expect(homeSrc).toMatch(/_urlSteamos \|\| _active\(deckSel\) \|\| _active\(machineSel\) \|\| _active\(steamosSel\)\) && !deckStatusMap/);
  });
  test('saved anti-cheat chips load the map and the browse pool', () => {
    expect(homeSrc).toMatch(/if \(_active\(acSel\)\) \{\s*if \(!acMap\) acMap = await loadAntiCheatMap\(\);/);
  });
});
