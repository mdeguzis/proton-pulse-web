// Cached lookup of the signed-in user's Steam wishlist appids, backed by the
// user_steam_wishlist Supabase table (#266 Phase 1). Loaded once per page and
// shared across components (home Wishlist filter chip, future profile card).
//
// First-load flow (needed because no page auto-triggers a wishlist sync the
// way profile.html auto-syncs the library on first visit): try to read the
// cached row; if it doesn't exist, POST to the sync-steam-wishlist edge
// function once, then re-read. Only fires when the user is signed in.
import { SB_URL, SB_KEY } from '../config.js?v=cd6114a7';

let _appIdsCache = null; // Set<number> | null

async function _readWishlistRow(session) {
  const url = `${SB_URL}/user_steam_wishlist?select=appids&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (!r.ok) {
    console.debug('[user-wishlist] fetch failed', { status: r.status, source: 'user_steam_wishlist' });
    return { rows: [], ok: false, status: r.status };
  }
  const rows = await r.json();
  return { rows: Array.isArray(rows) ? rows : [], ok: true };
}

async function _triggerSync(session) {
  const url = `${SB_URL.replace('/rest/v1', '')}/functions/v1/sync-steam-wishlist`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const text = await r.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  console.debug('[user-wishlist] sync triggered', { ok: r.ok, status: r.status, item_count: payload?.item_count, error: payload?.error, source: 'sync-steam-wishlist' });
  return { ok: r.ok, payload };
}

export async function getMyWishlistAppIds() {
  if (_appIdsCache !== null) return _appIdsCache;
  try {
    const session = await window.SupaAuth?.getSession?.();
    if (!session?.access_token) {
      _appIdsCache = new Set();
      return _appIdsCache;
    }
    let { rows } = await _readWishlistRow(session);
    // No cached row -> trigger the sync once and re-read. Handles the
    // "first click on the Wishlist chip after signing in with Steam"
    // case that would otherwise show an empty result.
    if (rows.length === 0) {
      const sync = await _triggerSync(session);
      if (sync.ok) {
        const reread = await _readWishlistRow(session);
        rows = reread.rows;
      }
    }
    const list = rows.length ? rows[0].appids : null;
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
