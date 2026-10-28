/**
 * #238: admin game_hides / game_remaps enforced on the frontend. Hidden
 * games stay out of search (results page and dropdown); a remapped app id
 * follows to its target with a "Moved here" banner.
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load(fetchImpl) {
  const warn = jest.fn();
  const ctx = loadEsm(['js/app/lib/game-hides.js'], {
    SB_URL: 'https://sb.example/rest/v1',
    SB_KEY: 'anon',
    fetch: fetchImpl || jest.fn(),
    console: { debug: () => {}, warn },
  });
  return { ...ctx, warn };
}

describe('resolveRemap', () => {
  const { resolveRemap } = load();
  const map = (pairs) => new Map(pairs.map(([f, t, r]) => [f, { to: t, reason: r || '' }]));

  test('not remapped returns null', () => {
    expect(resolveRemap('10', map([['20', '30']]))).toBeNull();
    expect(resolveRemap('10', new Map())).toBeNull();
    expect(resolveRemap('10', null)).toBeNull();
  });

  test('follows one hop and keeps the first reason', () => {
    expect(resolveRemap('10', map([['10', '20', 'dupe']]))).toEqual({ target: '20', reason: 'dupe', hops: 1 });
  });

  test('follows a chain up to the hop cap', () => {
    const m = map([['1', '2', 'a'], ['2', '3', 'b'], ['3', '4'], ['4', '5']]);
    expect(resolveRemap('1', m)).toEqual({ target: '4', reason: 'a', hops: 3 });
  });

  test('a loop resolves to nothing instead of bouncing forever', () => {
    expect(resolveRemap('1', map([['1', '2'], ['2', '1']]))).toBeNull();
  });

  test('an unsafe target is ignored', () => {
    expect(resolveRemap('1', map([['1', 'x"><script>']]))).toBeNull();
    expect(resolveRemap('1', map([['1', 'gog:123']]))).toEqual({ target: 'gog:123', reason: '', hops: 1 });
  });
});

describe('withoutHidden', () => {
  const { withoutHidden } = load();
  test('drops hidden ids and keeps the rest', () => {
    const rows = [['10', 'A'], ['629', 'B'], [43129, 'C']];
    expect(withoutHidden(rows, new Set(['629', '43129']), (r) => r[0])).toEqual([['10', 'A']]);
  });
  test('no hides returns rows unchanged', () => {
    const rows = [['10']];
    expect(withoutHidden(rows, new Set(), (r) => r[0])).toBe(rows);
  });
});

describe('loadGameRemaps', () => {
  test('reads only the public columns and builds the map', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ from_app_id: '10', to_app_id: '20', reason: 'dupe' }, { from_app_id: '', to_app_id: '5' }]),
    });
    const { loadGameRemaps } = load(fetchImpl);
    const m = await loadGameRemaps();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://sb.example/rest/v1/game_remaps?select=from_app_id,to_app_id,reason');
    expect(m.get('10')).toEqual({ to: '20', reason: 'dupe' });
    expect(m.size).toBe(1);
  });

  test('a failed fetch warns and follows no remaps', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const { loadGameRemaps, warn } = load(fetchImpl);
    expect((await loadGameRemaps()).size).toBe(0);
    expect(warn).toHaveBeenCalledWith('[game-remaps] fetch failed, remaps not followed', expect.objectContaining({ status: 503 }));
  });
});

describe('wiring', () => {
  const GP = read('js/app/components/game-page.js');
  const SEARCH = read('js/app/components/search.js');

  test('game page follows a remap after the hidden-game gate and shows the banner', () => {
    expect(GP.indexOf('resolveRemap(appId, await loadGameRemaps())')).toBeGreaterThan(GP.indexOf('const hides = await loadGameHides()'));
    expect(GP).toMatch(/window\.location\.replace\(`#\/app\/\$\{hit\.target\}`\)/);
    expect(GP).toMatch(/\$\{remapBanner\}\s*\n\s*\$\{replacedBanner\}/);
    expect(GP).toMatch(/<code>\$\{esc\(remapNotice\.from\)\}<\/code>/);
    expect(GP).toMatch(/\$\{esc\(remapNotice\.reason\)\}/);
  });

  test('both search paths drop hidden games', () => {
    expect(SEARCH).toMatch(/withoutHidden\(apiResp\.rows, hides, \(row\) => row\[0\]\)/);
    expect(SEARCH).toMatch(/withoutHidden\(apiRows, hides, \(r\) => r\.appId\)/);
    expect((SEARCH.match(/loadGameHides\(\)/g) || []).length).toBe(2);
  });
});
