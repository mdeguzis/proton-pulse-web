// Admin-only API Explorer client for keyed Steam Web API endpoints.
// Calls the steam-library-lookup edge function, which verifies the caller
// is an admin with manage_admins before attaching the Steam Web API key
// and hitting Steam. See supabase/functions/steam-library-lookup/index.ts
// and issue #221.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v=ffed3d84';

const ENDPOINT = () => `${SUPABASE_URL}/functions/v1/steam-library-lookup`;

const LIBRARY_ENDPOINT_KEYS = new Set([
  'steam_get_owned_games',
  'steam_get_recently_played',
  'steam_resolve_vanity',
]);

export function isLibraryEndpoint(key) {
  return LIBRARY_ENDPOINT_KEYS.has(String(key));
}

// Grabs the current signed-in session via the global supabase client so callers
// don't have to plumb the token in. Matches the pattern in boxart.js _authedFetch.
async function _session() {
  const SupaAuth = window.SupaAuth || window.protonPulseAuth;
  if (!SupaAuth || typeof SupaAuth.getSession !== 'function') return null;
  try { return await SupaAuth.getSession(); } catch { return null; }
}

// Client for the three admin-gated Steam Web API endpoints. Returns the
// same envelope shape steam-explore returns: { ok, endpoint, arg, url,
// method, status, data, error? } so the Explorer renders it uniformly.
export async function lookupLibrary(endpoint, { steamid = '', vanityurl = '' } = {}) {
  const session = await _session();
  if (!session?.access_token) {
    return { ok: false, endpoint, error: 'sign in as an admin first' };
  }
  try {
    const res = await fetch(ENDPOINT(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        endpoint: String(endpoint),
        steamid: String(steamid || ''),
        vanityurl: String(vanityurl || ''),
      }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, endpoint, error: `proxy HTTP ${res.status} (no body)` };
    return body;
  } catch (e) {
    return { ok: false, endpoint, error: `network: ${e.message || String(e)}` };
  }
}
