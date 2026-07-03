// Admin API Explorer client. Calls the steam-explore edge function, which
// proxies whitelisted public Steam endpoints server-side (Steam is CORS-blocked
// from the browser) and returns the raw JSON for inspection. See
// supabase/functions/steam-explore/index.ts and issue #186.

import { SUPABASE_URL } from '../config.js?v=ffed3d84';

const STEAM_EXPLORE_ENDPOINT = () => `${SUPABASE_URL}/functions/v1/steam-explore`;

// endpoint is a whitelisted "<store>_<endpoint>" key (e.g. steam_appdetails,
// steam_deck, gog_product, gog_search, epic_search). Pass { id } for id-based
// endpoints (numeric) or { term } for search endpoints. Returns the proxy
// payload { ok, endpoint, arg, url, status, data } or { ok:false, error }.
export async function exploreStore(endpoint, { id = '', term = '' } = {}) {
  try {
    const res = await fetch(STEAM_EXPLORE_ENDPOINT(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: String(endpoint), id: String(id), term: String(term) }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: `proxy HTTP ${res.status} (no body)` };
    return body;
  } catch (e) {
    return { ok: false, error: `network: ${e.message || String(e)}` };
  }
}
