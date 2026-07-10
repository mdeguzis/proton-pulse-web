/**
 * Profile Wishlist card + type-breakdown tests (#266 stats).
 *
 * Covers:
 *  1. steam-wishlist.js REST helpers hit the right URLs with auth headers.
 *  2. computeTypeBreakdown intersects appids with the cache and buckets.
 *  3. profile.html markup + main.js wiring exposes the new field ids.
 *  4. library.js exports the new refreshWishlist path.
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

// ---------- Part 1: steam-wishlist.js REST helpers ----------------------

function loadSteamWishlistApi({ fetchImpl }) {
  return loadEsm(['js/profile/api/steam-wishlist.js'], {
    fetch: fetchImpl,
    SUPABASE_URL: 'https://sb.test',
    supabaseHeaders: (session) => ({
      apikey: 'anon',
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    }),
    console: { warn: () => {}, debug: () => {} },
  });
}

describe('steam-wishlist.js', () => {
  test('fetchMyWishlistRow requests the right table columns', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ steam_id: '1', item_count: 3, appids: [1, 2, 3], synced_at: 'x' }]),
    });
    const { fetchMyWishlistRow } = loadSteamWishlistApi({ fetchImpl });
    const row = await fetchMyWishlistRow({ access_token: 't' });
    expect(row.item_count).toBe(3);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://sb.test/rest/v1/user_steam_wishlist?select=steam_id,item_count,appids,synced_at&limit=1');
    expect(opts.headers.Authorization).toBe('Bearer t');
  });

  test('fetchMyWishlistRow returns null when no session', async () => {
    const fetchImpl = jest.fn();
    const { fetchMyWishlistRow } = loadSteamWishlistApi({ fetchImpl });
    expect(await fetchMyWishlistRow(null)).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fetchMyWishlistRow throws on non-ok response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false, status: 500,
      text: () => Promise.resolve('server error'),
    });
    const { fetchMyWishlistRow } = loadSteamWishlistApi({ fetchImpl });
    await expect(fetchMyWishlistRow({ access_token: 't' })).rejects.toThrow(/HTTP 500/);
  });

  test('syncMyWishlist POSTs to the edge function', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true, text: () => Promise.resolve('{"ok":true,"item_count":7}'),
    });
    const { syncMyWishlist } = loadSteamWishlistApi({ fetchImpl });
    const out = await syncMyWishlist({ access_token: 't' });
    expect(out.item_count).toBe(7);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://sb.test/functions/v1/sync-steam-wishlist');
    expect(opts.method).toBe('POST');
  });

  test('syncMyWishlist rejects when there is no session', async () => {
    const fetchImpl = jest.fn();
    const { syncMyWishlist } = loadSteamWishlistApi({ fetchImpl });
    await expect(syncMyWishlist(null)).rejects.toThrow(/Sign in required/);
  });

  test('syncMyWishlist surfaces upstream error message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false, status: 400,
      text: () => Promise.resolve('{"error":"no steam id"}'),
    });
    const { syncMyWishlist } = loadSteamWishlistApi({ fetchImpl });
    await expect(syncMyWishlist({ access_token: 't' })).rejects.toThrow(/no steam id/);
  });
});


// ---------- Part 2: computeTypeBreakdown --------------------------------

function loadBreakdown({ fetchImpl }) {
  return loadEsm(['js/profile/lib/steam-type-breakdown.js'], {
    fetch: fetchImpl,
    dataUrl: (name) => Promise.resolve(name),
    console: { debug: () => {} },
  });
}

describe('computeTypeBreakdown', () => {
  const cache = {
    '10': 'game', '20': 'game', '30': 'game',
    '100': 'dlc', '101': 'dlc',
    '200': 'demo',
    '300': 'mod',
    '400': 'software',
    // 999 intentionally missing -> bucketed as 'unknown'.
  };

  test('buckets ids by cache type, drops missing to unknown', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(cache) });
    const { computeTypeBreakdown } = loadBreakdown({ fetchImpl });
    const r = await computeTypeBreakdown([10, 20, 30, 100, 101, 200, 300, 400, 999]);
    expect(r.total).toBe(9);
    expect(r.cached).toBe(8);
    expect(r.uncached).toBe(1);
    expect(r.counts.game).toBe(3);
    expect(r.counts.dlc).toBe(2);
    expect(r.counts.demo).toBe(1);
    expect(r.counts.mod).toBe(1);
    expect(r.counts.software).toBe(1);
    expect(r.counts.unknown).toBe(1);
    // Order is descending by count, top bucket is game (3).
    expect(r.order[0]).toEqual(['game', 3]);
  });

  test('empty input yields total 0 and empty order list', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(cache) });
    const { computeTypeBreakdown } = loadBreakdown({ fetchImpl });
    const r = await computeTypeBreakdown([]);
    expect(r.total).toBe(0);
    expect(r.order).toEqual([]);
  });

  test('cache miss (non-ok response) buckets everything as unknown', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const { computeTypeBreakdown } = loadBreakdown({ fetchImpl });
    const r = await computeTypeBreakdown([10, 100, 999]);
    expect(r.counts.unknown).toBe(3);
    expect(r.cached).toBe(0);
  });

  test('caches the type map so repeat calls skip the fetch', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(cache) });
    const { computeTypeBreakdown } = loadBreakdown({ fetchImpl });
    await computeTypeBreakdown([10]);
    await computeTypeBreakdown([20]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});


// ---------- Part 3: markup + wiring -------------------------------------

const PROFILE_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'profile.html'),
  'utf8',
);
const PROFILE_MAIN = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'profile', 'main.js'),
  'utf8',
);
const LIBRARY_COMPONENT = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'profile', 'components', 'library.js'),
  'utf8',
);

describe('profile.html markup + main.js wiring', () => {
  test('profile.html has the new wishlist card ids alongside the library ids', () => {
    for (const id of ['library-count', 'library-status', 'library-empty', 'library-types', 'library-refresh-btn',
                      'wishlist-count', 'wishlist-status', 'wishlist-empty', 'wishlist-types', 'wishlist-refresh-btn']) {
      expect(PROFILE_HTML).toContain(`id="${id}"`);
    }
  });

  test('main.js wires every id into initLibrary()', () => {
    expect(PROFILE_MAIN).toMatch(/libraryTypes:[\s\S]{0,80}library-types/);
    expect(PROFILE_MAIN).toMatch(/wishlistCount:[\s\S]{0,80}wishlist-count/);
    expect(PROFILE_MAIN).toMatch(/wishlistRefresh:[\s\S]{0,80}wishlist-refresh-btn/);
    expect(PROFILE_MAIN).toMatch(/wishlistTypes:[\s\S]{0,80}wishlist-types/);
  });

  test('library.js exports refreshLibrary AND refreshWishlist paths', () => {
    expect(LIBRARY_COMPONENT).toContain('async function refreshLibrary()');
    expect(LIBRARY_COMPONENT).toContain('async function refreshWishlist()');
    expect(LIBRARY_COMPONENT).toContain('return { refreshLibrary, refreshWishlist, loadLibraryCached, loadWishlistCached };');
    // Both cards render a type-breakdown line via the same helper.
    expect(LIBRARY_COMPONENT).toContain('computeTypeBreakdown(appids)');
  });
});
