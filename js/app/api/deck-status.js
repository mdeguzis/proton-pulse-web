// deck-status (api) for the app page. Relocated from app.js.

export const DECK_CAT_MAP = { 0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified' };
// display_type in resolved_items: 2=fail, 3=info/caveat, 4=pass
export const DECK_DISPLAY_MAP = { 4: true, 3: null, 2: false };

// cache fetched deck compat so we dont re-fetch on every render
export const _deckCache = {};

/**
 * Fetch the Steam Deck compatibility status for a game from the Steam store API.
 * Results are cached in `_deckCache` by appId for the page lifetime.
 * Hits `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=`.
 * @param {string|number} appId - Steam app ID.
 * @returns {Promise<{status: string, criteria: Array<boolean|null>|null}>}
 *   `status` is one of `'unknown'|'unsupported'|'playable'|'verified'`.
 *   `criteria` is an array of 4 pass/fail/info values mapped from `resolved_items`, or null if unavailable.
 */
export async function fetchDeckStatusForApp(appId) {
  if (!appId) return { status: 'unknown', criteria: null };
  if (_deckCache[appId]) return _deckCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${appId}`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (!d.success) throw new Error('no data');
    const cat = d.results?.resolved_category ?? 0;
    const status = DECK_CAT_MAP[cat] || 'unknown';
    // map each resolved_item to a true/false/null criterion result
    const items = d.results?.resolved_items || [];
    const criteria = items.length >= 4
      ? items.slice(0, 4).map(i => DECK_DISPLAY_MAP[i.display_type] ?? null)
      : null;
    const ret = { status, criteria };
    _deckCache[appId] = ret;
    return ret;
  } catch {
    const ret = { status: 'unknown', criteria: null };
    _deckCache[appId] = ret;
    return ret;
  }
}

// synchronous fallback used for initial render before the async fetch returns
/**
 * Synchronous cache read for Deck compatibility status. Returns cached data if available,
 * or a default `'unknown'` result if the async fetch has not yet completed.
 * @param {string|number} appId - Steam app ID.
 * @returns {{status: string, criteria: Array<boolean|null>|null}}
 */
export function getDeckStatusForApp(appId) {
  return _deckCache[appId] || { status: 'unknown', criteria: null };
}

// cache fetched system requirements
export const _reqsCache = {};

/**
 * Fetch the PC minimum and recommended system requirements for a game from the Steam store API.
 * Results are cached in `_reqsCache` by appId for the page lifetime.
 * Hits `https://store.steampowered.com/api/appdetails?appids=&filters=basic`.
 * @param {string|number} appId - Steam app ID.
 * @returns {Promise<{minimum: string|null, recommended: string|null}|null>}
 *   Requirement strings (raw HTML from Steam), or null if unavailable or on failure.
 */
export async function fetchMinRequirements(appId) {
  if (!appId) return null;
  if (_reqsCache[appId] !== undefined) return _reqsCache[appId];
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic&l=english`);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const app = d?.[appId]?.data;
    if (!app) { _reqsCache[appId] = null; return null; }
    const reqs = app.pc_requirements;
    if (!reqs || (typeof reqs === 'object' && !reqs.minimum)) {
      _reqsCache[appId] = null;
      return null;
    }
    const ret = {
      minimum: reqs.minimum || null,
      recommended: reqs.recommended || null,
    };
    _reqsCache[appId] = ret;
    return ret;
  } catch {
    _reqsCache[appId] = null;
    return null;
  }
}

// Inline SVGs for Deck status icons. All 24x24 viewBox + currentColor so a
// single CSS color rule paints them.
