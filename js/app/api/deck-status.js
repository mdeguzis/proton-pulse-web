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
      // Steam's appdetails endpoint does not send Access-Control-Allow-Origin
      // to github.io / proton-pulse.com, so a direct browser fetch is
      // silently blocked (empty response -> Native badge never fires,
      // Metadata modal errors). Route through the steam-appdetails Supabase
      // edge function which forwards server-side and re-serves with an open
      // CORS header + 10 min cache.
      const base = (typeof window !== 'undefined' && window.SUPABASE_URL) || '';
      if (!base) throw new Error('SUPABASE_URL not set');
      const r = await fetch(`${base}/functions/v1/steam-appdetails?appId=${encodeURIComponent(appId)}`);
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
 * Full-fat metadata bundle for the Metadata modal on the game page.
 * Structured after SteamDB's Metadata tab: everything we can pull out of
 * a single appdetails response, one place, so the modal reads like a
 * dossier. All fields are optional; callers render only what came back
 * so a partial Steam response degrades gracefully. The raw payload rides
 * along so a "View raw JSON" viewer can dump the untouched dict.
 */
export async function fetchAppMetadata(appId) {
  const app = await _fetchAppBasic(appId);
  if (!app) return null;
  const asStrings = (arr, key) => Array.isArray(arr)
    ? arr.map(x => (typeof x === 'string' ? x : x?.[key])).filter(Boolean)
    : [];
  return {
    // Identity
    appId:            String(appId),
    name:             app.name || null,
    type:             app.type || null,
    requiredAge:      app.required_age ?? null,
    isFree:           !!app.is_free,
    fullgame:         app.fullgame || null,   // set on DLC
    dlcCount:         Array.isArray(app.dlc) ? app.dlc.length : 0,
    // Attribution
    developers:       Array.isArray(app.developers) ? app.developers : [],
    publishers:       Array.isArray(app.publishers) ? app.publishers : [],
    // Availability
    platforms:        app.platforms || null,
    releaseDate:      app.release_date?.date || null,
    comingSoon:       !!app.release_date?.coming_soon,
    // Taxonomy
    genres:           asStrings(app.genres,     'description'),
    categories:       asStrings(app.categories, 'description'),
    // Reviews / scoring
    metacriticScore:  app.metacritic?.score ?? null,
    metacriticUrl:    app.metacritic?.url   || null,
    reviewsSummary:   typeof app.reviews === 'string'
      ? app.reviews.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)
      : null,
    // System-level
    controllerSupport: app.controller_support || null,
    supportedLanguages: typeof app.supported_languages === 'string'
      ? app.supported_languages.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      : null,
    hasAchievements:  !!app.achievements?.total,
    achievementCount: app.achievements?.total ?? 0,
    // Distribution
    packageIds:       Array.isArray(app.packages) ? app.packages : [],
    packageGroups:    Array.isArray(app.package_groups)
      ? app.package_groups.map(g => ({
          name:  g.name  || null,
          title: g.title || null,
          subCount: Array.isArray(g.subs) ? g.subs.length : 0,
        }))
      : [],
    // Support
    supportInfo:      app.support_info || null,
    website:          app.website || null,
    // Per-OS system requirements: normalize to plain-text minimum + rec
    pcRequirements:    _reqPair(app.pc_requirements),
    macRequirements:   _reqPair(app.mac_requirements),
    linuxRequirements: _reqPair(app.linux_requirements),
    // Compliance
    contentDescriptors: Array.isArray(app.content_descriptors?.notes)
      ? app.content_descriptors.notes
      : (typeof app.content_descriptors?.notes === 'string'
          ? [app.content_descriptors.notes] : []),
    // Escape hatch so the modal can offer a "View raw JSON" toggle.
    raw: app,
  };
}

/**
 * Cached-per-page fetch of the pipeline-populated per-OS depot dates
 * (issue #215). Returns { found: bool, os: { windows|mac|linux: {
 * first_seen, last_updated, depots } } } or null on network error.
 *
 * A cache miss (found === false) is NOT an error -- the pipeline is
 * still ramping up its coverage; callers should fall back to the
 * SteamDB deep link when found is false.
 */
/**
 * Cached fetch of the most recent ISteamNews/GetNewsForApp entries via
 * the steam-news edge function proxy. Returns { found: bool, newest_ts,
 * items[] } or null on network error. Called by the Metadata modal as
 * a fallback when the PICS depot cache is empty for this app -- the
 * newest news date acts as a "when was this game last updated" signal
 * with no per-OS granularity but full public-endpoint coverage.
 */
const _appNewsCache = {};
export function fetchAppNews(appId, { count = 3, maxlength = 200 } = {}) {
  if (!appId) return Promise.resolve(null);
  const key = `${appId}|${count}|${maxlength}`;
  if (_appNewsCache[key] !== undefined) return _appNewsCache[key];
  const p = (async () => {
    try {
      const base = (typeof window !== 'undefined' && window.SUPABASE_URL) || '';
      if (!base) return null;
      const url = `${base}/functions/v1/steam-news?appId=${encodeURIComponent(appId)}&count=${count}&maxlength=${maxlength}`;
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  })();
  _appNewsCache[key] = p;
  return p;
}

const _depotInfoCache = {};
export function fetchAppDepotInfo(appId) {
  if (!appId) return Promise.resolve(null);
  if (_depotInfoCache[appId] !== undefined) return _depotInfoCache[appId];
  const p = (async () => {
    try {
      const base = (typeof window !== 'undefined' && window.SUPABASE_URL) || '';
      if (!base) return null;
      const r = await fetch(`${base}/functions/v1/steam-depot-info?appId=${encodeURIComponent(appId)}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  })();
  _depotInfoCache[appId] = p;
  return p;
}

function _reqPair(reqs) {
  if (!reqs || (typeof reqs === 'object' && !reqs.minimum && !reqs.recommended)) return null;
  const strip = (s) => typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  return {
    minimum:     strip(reqs.minimum),
    recommended: strip(reqs.recommended),
  };
}

// Inline SVGs for Deck status icons. All 24x24 viewBox + currentColor so a
// single CSS color rule paints them.
