// Shared helper for pages that want to fall back to the saved public
// Steam profile when the user is signed out. Reads the localStorage
// key that /lookup persists (issue #323) and calls the
// public-steam-profile edge function to return the SAME shape
// getMyLibraryAppIds / getMyWishlistAppIds return -- a Set of appIds.
//
// A single edge-fn call returns both the library and the wishlist so
// the two callers on a page share one round-trip.
//
// Called by:
//   js/app/components/home.js (My Library / My Wishlist nav filters)
//
// Read-only: this helper never writes to localStorage. Only /lookup writes.

import { LS_INPUT_KEY } from '../../shared/lookup-storage.js?v=7b8989d7';

let _cache = null; // per-page in-memory cache so library + wishlist share one fetch

function readSavedInput() {
  try {
    return (localStorage.getItem(LS_INPUT_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function hasSavedLookup() {
  return !!readSavedInput();
}

async function fetchProfileOnce() {
  if (_cache) return _cache;
  const input = readSavedInput();
  if (!input) {
    _cache = { ok: false };
    return _cache;
  }
  const url = `${window.SUPABASE_URL}/functions/v1/public-steam-profile`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: window.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${window.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ input }),
    });
    const body = await res.json().catch(() => ({}));
    _cache = { ok: !!body.ok, body };
  } catch (err) {
    console.warn('[saved-lookup] fetch failed', err);
    _cache = { ok: false };
  }
  return _cache;
}

/**
 * Returns a Set of numeric appIds representing the saved profile's public
 * Steam library, or an empty Set if no saved lookup exists or the profile
 * is private.
 */
export async function getSavedLookupLibraryAppIds() {
  const c = await fetchProfileOnce();
  if (!c.ok) return new Set();
  const games = c.body?.games || [];
  return new Set(games.map((g) => Number(g.appid)).filter(Number.isFinite));
}

/**
 * Returns a Set of numeric appIds representing the saved profile's public
 * Steam wishlist, or an empty Set if no saved lookup exists or the wishlist
 * is private.
 */
export async function getSavedLookupWishlistAppIds() {
  const c = await fetchProfileOnce();
  if (!c.ok) return new Set();
  const wishlist = c.body?.wishlist || [];
  return new Set(wishlist.map((w) => Number(w.appid)).filter(Number.isFinite));
}
