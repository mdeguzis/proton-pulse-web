// deck-status (api) for the app page. Relocated from app.js.

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';

export const DECK_CAT_MAP = { 0: 'unknown', 1: 'unsupported', 2: 'playable', 3: 'verified' };
// display_type in resolved_items: 2=fail, 3=info/caveat, 4=pass
export const DECK_DISPLAY_MAP = { 4: true, 3: null, 2: false };

// cache fetched deck compat so we dont re-fetch on every render
export const _deckCache = {};

// Steam's ajaxgetdeckappcompatibilityreport endpoint is NOT CORS-enabled, so a
// browser fetch always failed and every game fell back to "Unknown ?". The
// pipeline now fetches it server-side and publishes deck-status.json (task #37,
// scripts/pipeline/deck_status.py); we read that map here. Loaded once.
let _deckMap = null;
let _deckMapLoading = null;

function _loadDeckMap() {
  if (_deckMap) return Promise.resolve(_deckMap);
  if (_deckMapLoading) return _deckMapLoading;
  _deckMapLoading = dataUrl('deck-status.json')
    .then((name) => fetch(name))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((m) => { _deckMap = (m && typeof m === 'object') ? m : {}; return _deckMap; });
  return _deckMapLoading;
}

/**
 * Steam Deck compatibility status for a game, from the pipeline-published
 * deck-status.json map. Results are cached in `_deckCache` by appId.
 * @param {string|number} appId - Steam app ID.
 * @returns {Promise<{status: string, criteria: Array<boolean|null>|null}>}
 *   `status` is one of `'unknown'|'unsupported'|'playable'|'verified'`.
 *   `criteria` is an array of 4 pass/fail/info values, or null if unavailable.
 */
export async function fetchDeckStatusForApp(appId) {
  if (!appId) return { status: 'unknown', criteria: null };
  if (_deckCache[appId]) return _deckCache[appId];
  const map = await _loadDeckMap();
  const entry = map[String(appId)];
  const ret = entry && entry.status
    ? { status: entry.status, criteria: entry.criteria || null }
    : { status: 'unknown', criteria: null };
  _deckCache[appId] = ret;
  return ret;
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

// Page-lifetime cache of the raw appdetails `.data` object per appId, so
// fetchMinRequirements + fetchLinuxNativeSupport (and any future readers
// of the same payload) share a single network hit. We cache the in-flight
// Promise, not just the resolved value, because concurrent callers (via
// Promise.all) hit the cache lookup before the first fetch resolves.
const _appBasicCache = {};

function _fetchAppBasic(appId) {
  if (!appId) return Promise.resolve(null);
  if (_appBasicCache[appId] !== undefined) return _appBasicCache[appId];
  const p = (async () => {
    try {
      // Full appdetails payload -- filters=basic silently omits platforms,
      // developers, publishers, categories, genres, and release_date that
      // fetchLinuxNativeSupport / the Metadata modal all read. Dropping the
      // filter costs a few KB more per response but gives us one shared
      // fetch for every metadata reader instead of two overlapping calls.
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      return d?.[appId]?.data ?? null;
    } catch {
      return null;
    }
  })();
  _appBasicCache[appId] = p;
  return p;
}

// legacy re-export: some callers read _reqsCache directly in tests. Keep a
// derived view so the old debugging path still works.
export const _reqsCache = _appBasicCache;

/**
 * Fetch the PC minimum and recommended system requirements for a game from the Steam store API.
 * @param {string|number} appId - Steam app ID.
 * @returns {Promise<{minimum: string|null, recommended: string|null}|null>}
 *   Requirement strings (raw HTML from Steam), or null if unavailable or on failure.
 */
export async function fetchMinRequirements(appId) {
  const app = await _fetchAppBasic(appId);
  if (!app) return null;
  const reqs = app.pc_requirements;
  if (!reqs || (typeof reqs === 'object' && !reqs.minimum)) return null;
  return {
    minimum: reqs.minimum || null,
    recommended: reqs.recommended || null,
  };
}

/**
 * Does this game ship a native Linux binary per Steam's `platforms.linux`
 * flag? Uses the same cached appdetails fetch as fetchMinRequirements so
 * calling both on the same page hits Steam once.
 * @param {string|number} appId
 * @returns {Promise<boolean>} true when Steam advertises a native Linux
 *   build; false for both "Steam says no" and "we couldn't tell". Callers
 *   render nothing on false, so a false-negative just hides the badge.
 */
export async function fetchLinuxNativeSupport(appId) {
  const app = await _fetchAppBasic(appId);
  return !!(app && app.platforms && app.platforms.linux === true);
}

/**
 * Compact metadata bundle for the Metadata modal on the game page.
 * Structured after SteamDB's Metadata tab so the modal is a familiar
 * side-by-side reference. All fields are optional; callers render only
 * what came back so a partial Steam response degrades gracefully.
 */
export async function fetchAppMetadata(appId) {
  const app = await _fetchAppBasic(appId);
  if (!app) return null;
  return {
    name:            app.name || null,
    type:            app.type || null,
    developers:      Array.isArray(app.developers)      ? app.developers      : [],
    publishers:      Array.isArray(app.publishers)      ? app.publishers      : [],
    platforms:       app.platforms || null,
    releaseDate:     app.release_date?.date || null,
    comingSoon:      !!app.release_date?.coming_soon,
    genres:          Array.isArray(app.genres)          ? app.genres.map(g => g.description).filter(Boolean) : [],
    categories:      Array.isArray(app.categories)      ? app.categories.map(c => c.description).filter(Boolean) : [],
    metacriticScore: app.metacritic?.score ?? null,
    metacriticUrl:   app.metacritic?.url   || null,
    controllerSupport: app.controller_support || null,
    // Language list is a single HTML-ish string; strip tags for display.
    supportedLanguages: typeof app.supported_languages === 'string'
      ? app.supported_languages.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      : null,
  };
}

// Inline SVGs for Deck status icons. All 24x24 viewBox + currentColor so a
// single CSS color rule paints them.
