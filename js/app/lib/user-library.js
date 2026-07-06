// Cached lookup of the signed-in user's Steam library appids, backed by the
// user_steam_library Supabase table. Loaded once per page and shared across
// components (home chart, ownership checks, etc.) (#199).
import { SB_URL, SB_KEY } from '../config.js?v=f9591262';

let _appIdsCache = null; // Set<number> | null

export async function getMyLibraryAppIds() {
  if (_appIdsCache !== null) return _appIdsCache;
  try {
    const session = await window.SupaAuth?.getSession?.();
    if (!session?.access_token) {
      _appIdsCache = new Set();
      return _appIdsCache;
    }
    const url = `${SB_URL}/user_steam_library?select=appids&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${session.access_token}`,
      },
    });
    if (!r.ok) {
      console.debug('[user-library] fetch failed', { status: r.status, source: 'user_steam_library' });
      _appIdsCache = new Set();
      return _appIdsCache;
    }
    const rows = await r.json();
    const list = Array.isArray(rows) && rows.length ? rows[0].appids : null;
    _appIdsCache = new Set((Array.isArray(list) ? list : []).map(Number).filter(Number.isFinite));
    console.debug('[user-library] loaded', { count: _appIdsCache.size, source: 'user_steam_library' });
    return _appIdsCache;
  } catch (e) {
    console.debug('[user-library] threw', { error: e?.message });
    _appIdsCache = new Set();
    return _appIdsCache;
  }
}

export function invalidateMyLibraryCache() {
  _appIdsCache = null;
}
