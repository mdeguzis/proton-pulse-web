/**
 * Wishlist filter tests (#266 Phase 1).
 *
 * Covers:
 *  1. js/app/lib/user-wishlist.js -- fetches, caches, and no-throw fallbacks.
 *  2. The _filterByWishlist helper and its wire-up in home.js source.
 */
const { loadEsm } = require('./_esm-vm.js');

// ---------- Part 1: user-wishlist module --------------------------------

function loadWishlistModule({ session, fetchImpl } = {}) {
  const fakeSupaAuth = {
    getSession: () => Promise.resolve(session),
  };
  const ctx = loadEsm(['js/app/lib/user-wishlist.js'], {
    fetch: fetchImpl || (() => Promise.resolve({ ok: false, status: 500 })),
    window: { SupaAuth: fakeSupaAuth },
    SB_URL: 'https://sb.test',
    SB_KEY: 'test-key',
    console: { debug: () => {} },
  });
  return ctx;
}

describe('getMyWishlistAppIds', () => {
  test('returns empty Set when there is no session', async () => {
    const { getMyWishlistAppIds } = loadWishlistModule({ session: null });
    const s = await getMyWishlistAppIds();
    // Set constructor from the vm context is not the same identity as the
    // test's global Set, so duck-type it (size + has).
    expect(typeof s.has).toBe('function');
    expect(s.size).toBe(0);
  });

  test('returns the appids from a successful fetch, coerced to numbers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ appids: [570, '440', 'garbage', -1, 730] }]),
    });
    const { getMyWishlistAppIds } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    const s = await getMyWishlistAppIds();
    expect([...s].sort()).toEqual([440, 570, 730]);
    // Verifies the URL is scoped to select=appids on the right table.
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://sb.test/user_steam_wishlist?select=appids&limit=1');
    expect(opts.headers.apikey).toBe('test-key');
    expect(opts.headers.Authorization).toBe('Bearer t');
  });

  test('caches after the first successful fetch', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ appids: [1, 2] }]),
    });
    const { getMyWishlistAppIds } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    await getMyWishlistAppIds();
    await getMyWishlistAppIds();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns empty Set when the fetch is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    const { getMyWishlistAppIds } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    const s = await getMyWishlistAppIds();
    expect(s.size).toBe(0);
  });

  test('returns empty Set when the fetch throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('net'));
    const { getMyWishlistAppIds } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    const s = await getMyWishlistAppIds();
    expect(s.size).toBe(0);
  });

  test('handles Supabase returning zero rows without crashing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const { getMyWishlistAppIds } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    const s = await getMyWishlistAppIds();
    expect(s.size).toBe(0);
  });

  test('invalidateMyWishlistCache forces a re-fetch on the next call', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ appids: [1] }]),
    });
    const { getMyWishlistAppIds, invalidateMyWishlistCache } = loadWishlistModule({
      session: { access_token: 't' },
      fetchImpl,
    });
    await getMyWishlistAppIds();
    invalidateMyWishlistCache();
    await getMyWishlistAppIds();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});


// ---------- Part 2: home.js filter chain integration --------------------

const fs = require('fs');
const path = require('path');

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8',
);

describe('home.js wires the wishlist filter (#266)', () => {
  test('imports getMyWishlistAppIds from user-wishlist.js', () => {
    expect(HOME_SRC).toMatch(/from '\.\.\/lib\/user-wishlist\.js/);
    expect(HOME_SRC).toContain('getMyWishlistAppIds');
  });

  test('defines _filterByWishlist with the same short-circuit shape as _filterByLibrary', () => {
    expect(HOME_SRC).toContain('function _filterByWishlist(reports, sel, wishlistAppIds)');
    // No wishlist selection => pass-through.
    expect(HOME_SRC).toMatch(/_filterByWishlist[\s\S]{0,200}sel\.has\('all'\)/);
    // Selection but no ids => empty (prompts sync).
    expect(HOME_SRC).toMatch(/_filterByWishlist[\s\S]{0,200}wishlistAppIds\.size === 0/);
  });

  test('both filter chains call _filterByWishlist', () => {
    const chainMatches = HOME_SRC.match(/_filterByWishlist\(_filterByLibrary/g) || [];
    expect(chainMatches.length).toBeGreaterThanOrEqual(2);
  });

  test('markup has a #home-wishlist-checks group with an "On wishlist" chip', () => {
    expect(HOME_SRC).toContain('id="home-wishlist-checks"');
    expect(HOME_SRC).toContain('data-value="wishlist"');
    expect(HOME_SRC).toContain('>On wishlist<');
  });

  test('wishlist selection lazy-loads the appid Set on first activation', () => {
    // Same shape as the library on-change: fetch the cached ids when the
    // "wishlist" value is first selected.
    expect(HOME_SRC).toMatch(/wishlistSel = sel;[\s\S]{0,200}sel\.has\('wishlist'\)[\s\S]{0,200}getMyWishlistAppIds/);
  });

  test('wishlistSel is included in save + restore + clear + badge count', () => {
    expect(HOME_SRC).toContain('wishlist: [...wishlistSel]');
    expect(HOME_SRC).toContain('wishlistSel = new Set(saved.wishlist || [])');
    expect(HOME_SRC).toContain('wishlistSel = new Set();');
    expect(HOME_SRC).toMatch(/librarySel\.size \+ wishlistSel\.size/);
  });
});
