// protondb (api) for the app page. Relocated from app.js.

import { CDN } from '../config.js?v=f9591262';
import { appIdToDir } from '../../lib/app-id.js?v=18a73fb7';

/**
 * Fetch the latest CDN report bundle for a game.
 * Hits `${CDN}/${appIdToDir(appId)}/latest.json` (static JSON hosted on CDN).
 * @param {string|number} appId - Canonical app ID ('730', 'gog:123', 'epic:abc').
 * @returns {Promise<Array<object>>} Array of report objects, or empty array on failure.
 */
export async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appIdToDir(appId)}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Session cache for user-triggered live ProtonDB checks. Keyed by appId so
// repeat visits within the session skip the network hit without auto-fetching.
export const _protonDbLiveCache = new Map();

// ProtonDB's summaries API only allows its own origin (CORS), so the browser
// cannot fetch it directly from our static site. We go through the
// `protondb-summary` Supabase Edge Function, which fetches server-side (no CORS
// there) and re-serves the JSON with an open CORS header. See issue #54.
const PROTONDB_PROXY_URL =
  'https://ilsgdshkaocrmibwdezk.supabase.co/functions/v1/protondb-summary';

// User-triggered live check: fetches the ProtonDB summary for a single game via
// our proxy. NOT called automatically -- must be triggered by the user clicking
// the "Check ProtonDB Live" button to avoid hammering their API on every load.
/**
 * Fetch a live ProtonDB summary for a single game through the proxy Edge Function.
 * Results are cached in `_protonDbLiveCache` for the session lifetime.
 * NOT called automatically -- must be user-triggered to avoid rate-limiting their API.
 * @param {string|number} appId - Steam app ID.
 * @returns {Promise<Array<{appId: string|number, tier: string, total: number, trendingTier: string, score: number, source: string, _liveOnly: boolean}>>}
 *   Single-element array with the summary, or empty array on failure or missing data.
 */
export async function fetchProtonDbLive(appId) {
  const key = String(appId);
  if (_protonDbLiveCache.has(key)) return _protonDbLiveCache.get(key);
  try {
    const r = await fetch(
      `${PROTONDB_PROXY_URL}?appId=${encodeURIComponent(appId)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) {
      console.debug(`[proton-pulse] ProtonDB live check proxy not ok | appId=${appId} status=${r.status} source=protondb-summary-proxy`);
      _protonDbLiveCache.set(key, []);
      return [];
    }
    const data = await r.json();
    // The proxy returns { found:false } when ProtonDB has no summary for the game.
    if (!data || data.found === false || !data.tier) {
      console.debug(`[proton-pulse] ProtonDB live check empty | appId=${appId} found=${data && data.found} source=protondb-summary-proxy`);
      _protonDbLiveCache.set(key, []);
      return [];
    }
    console.log(`[proton-pulse] live check for ${appId} | tier=${data.tier} total=${data.total} source=protondb-summary-proxy`);
    const result = [{
      appId,
      tier:         data.tier,
      total:        data.total || 0,
      trendingTier: data.trendingTier || data.tier,
      score:        data.score || 0,
      source:       'protondb-live',
      _liveOnly:    true,
    }];
    _protonDbLiveCache.set(key, result);
    return result;
  } catch (e) {
    console.debug(`[proton-pulse] ProtonDB live check failed | appId=${appId} error=${e.message} source=protondb-summary-proxy`);
    _protonDbLiveCache.set(key, []);
    return [];
  }
}


/** Deduplicate rows by voter_id, keeping only the most recent per unique client. */
