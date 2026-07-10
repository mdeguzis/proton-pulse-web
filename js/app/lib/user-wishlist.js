// Cached lookup of the signed-in user's Steam wishlist appids, backed by the
// user_steam_wishlist Supabase table (#266 Phase 1). Loaded once per page and
// shared across components (home Wishlist filter chip, future profile card).
import { SB_URL, SB_KEY } from '../config.js?v=f9591262';

let _appIdsCache = null; // Set<number> | null

export async function getMyWishlistAppIds() {
  if (_appIdsCache !== null) return _appIdsCache;
  try {
    const session = await window.SupaAuth?.getSession?.();
    if (!session?.access_token) {
      _appIdsCache = new Set();
      return _appIdsCache;
    }
    const url = `${SB_URL}/user_steam_wishlist?select=appids&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    if (!r.ok) {
      console.debug('[user-wishlist] fetch failed', { status: r.status, source: 'user_steam_wishlist' });
      _appIdsCache = new Set();
      return _appIdsCache;
    }
    const rows = await r.json();
    const list = Array.isArray(rows) && rows.length ? rows[0].appids : null;
    _appIdsCache = new Set(
      (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isFinite(n) && n > 0),
    );
    console.debug('[user-wishlist] loaded', { count: _appIdsCache.size, source: 'user_steam_wishlist' });
    return _appIdsCache;
  } catch (e) {
    console.debug('[user-wishlist] threw', { error: e?.message });
    _appIdsCache = new Set();
    return _appIdsCache;
  }
}

export function invalidateMyWishlistCache() {
  _appIdsCache = null;
}
