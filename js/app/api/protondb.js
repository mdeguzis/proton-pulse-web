// protondb (api) for the app page. Relocated from app.js.

import { CDN } from '../config.js?v=9970759a';

export async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appId}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Session cache for user-triggered live ProtonDB checks. Keyed by appId so
// repeat visits within the session skip the network hit without auto-fetching.
export const _protonDbLiveCache = new Map();

// User-triggered live check: fetches ProtonDB public API for a single game.
// NOT called automatically -- must be triggered by the user clicking the
// "Check ProtonDB Live" button to avoid hammering their API on every page load.
export async function fetchProtonDbLive(appId) {
  const key = String(appId);
  if (_protonDbLiveCache.has(key)) return _protonDbLiveCache.get(key);
  try {
    const r = await fetch(
      `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) { _protonDbLiveCache.set(key, []); return []; }
    const data = await r.json();
    if (!data || !data.tier) { _protonDbLiveCache.set(key, []); return []; }
    console.log(`[proton-pulse] live check for ${appId} | tier=${data.tier} total=${data.total} source=protondb-api`);
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
    console.debug(`[proton-pulse] ProtonDB live check failed | appId=${appId} error=${e.message}`);
    _protonDbLiveCache.set(key, []);
    return [];
  }
}


/** Deduplicate rows by voter_id, keeping only the most recent per unique client. */
