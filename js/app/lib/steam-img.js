// Single loader for all Steam header images.
// All pages and components must route through loadSteamImg / window.__steamImgLoad.
// Fallback chain: admin override -> akamai (primary, set as img src) -> cloudflare CDN -> game-images.json hash URL -> hidden placeholder.
//
// Admin overrides come from the box_art_overrides Supabase table. They
// take precedence over the akamai default URL, so when an admin sets a
// custom image it takes effect immediately (not after the next pipeline
// run). Overrides are fetched once per session, cached in sessionStorage,
// and applied via MutationObserver so dynamically-inserted images also
// pick them up.

import { normalizeSearchable } from './search-match.js?v=dd1b70b2';

const _CDN2 = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

// Session-scoped set so we only POST once per appid per tab; browsers navigating
// past the same broken card multiple times shouldn't hammer the reporter.
const _reportedMissing = new Set();

// Fire-and-forget report to image_load_errors so admin surfaces runtime 404s
// across any storefront. Table's on-conflict does the hit_count bump. Errors
// are swallowed (this is telemetry, not user-facing behavior) but logged for
// debugging (#199 follow-up).
function _reportMissingImage(appId, attemptedUrl) {
  const id = String(appId || '');
  if (!id || _reportedMissing.has(id)) return;
  _reportedMissing.add(id);
  if (!_SUPABASE_URL || !_SUPABASE_ANON_KEY) {
    console.debug('[steam-img] report skipped (no supabase env)', { appId: id });
    return;
  }
  const storeType = id.startsWith('gog:') ? 'gog' : id.startsWith('epic:') ? 'epic' : 'steam';
  const body = {
    app_id: id,
    store_type: storeType,
    attempted_url: attemptedUrl || null,
    last_seen: new Date().toISOString(),
  };
  fetch(`${_SUPABASE_URL}/rest/v1/image_load_errors?on_conflict=app_id`, {
    method: 'POST',
    headers: {
      apikey: _SUPABASE_ANON_KEY,
      Authorization: `Bearer ${_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  }).then(r => {
    console.debug('[steam-img] reportMissingImage', { appId: id, storeType, ok: r.ok, status: r.status, source: 'image_load_errors' });
  }).catch(err => {
    console.debug('[steam-img] reportMissingImage threw', { appId: id, error: err?.message });
  });
}

const _SUPABASE_URL      = window.SUPABASE_URL      || 'https://ilsgdshkaocrmibwdezk.supabase.co';
const _SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
const _OVERRIDES_CACHE_KEY = 'boxart_overrides_v1';
const _OVERRIDES_TTL_MS    = 5 * 60 * 1000;  // 5 min: fresh enough to reflect admin edits, no per-page-view fetch

let _overridesMap = null;    // { appId: image_url }
let _overridesPromise = null;

function _loadOverrides() {
  if (_overridesMap) return Promise.resolve(_overridesMap);
  if (_overridesPromise) return _overridesPromise;
  // Session cache: subsequent page loads within the same tab reuse the
  // fetched map without hitting the DB. Skips if stale or missing.
  try {
    const raw = sessionStorage.getItem(_OVERRIDES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < _OVERRIDES_TTL_MS && parsed.map) {
        _overridesMap = parsed.map;
        return Promise.resolve(_overridesMap);
      }
    }
  } catch (_) { /* corrupt cache -> refetch */ }
  const url = `${_SUPABASE_URL}/rest/v1/box_art_overrides?select=app_id,image_url`;
  _overridesPromise = fetch(url, {
    headers: {
      apikey: _SUPABASE_ANON_KEY,
      Authorization: `Bearer ${_SUPABASE_ANON_KEY}`,
    },
    cache: 'no-store',
  })
    .then(r => r.ok ? r.json() : [])
    .catch(() => [])
    .then(rows => {
      const map = {};
      for (const row of (rows || [])) {
        if (row?.app_id && row?.image_url) map[String(row.app_id)] = row.image_url;
      }
      _overridesMap = map;
      try { sessionStorage.setItem(_OVERRIDES_CACHE_KEY, JSON.stringify({ ts: Date.now(), map })); } catch (_) {}
      return map;
    });
  return _overridesPromise;
}

// Apply overrides to any img[data-appid] currently in the DOM whose
// current src does not already match the override URL. Idempotent.
function _applyOverrides(map, root = document) {
  if (!map || Object.keys(map).length === 0) return;
  const imgs = root.querySelectorAll('img[data-appid]');
  for (const img of imgs) {
    const appId = img.dataset.appid;
    const overrideUrl = map[appId];
    if (!overrideUrl) continue;
    if (img.src !== overrideUrl) {
      img.src = overrideUrl;
    }
  }
}

// Wire once: initial DOM scan + MutationObserver so cards inserted
// later (search results, load-more, tab switches) also get overrides
// applied without every renderer needing to know about them.
if (typeof document !== 'undefined') {
  const init = () => {
    _loadOverrides().then(map => {
      _applyOverrides(map);
      const obs = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches?.('img[data-appid]')) _applyOverrides(map, node.parentNode || document);
            else if (node.querySelector?.('img[data-appid]')) _applyOverrides(map, node);
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}

// Staging is served at /proton-pulse-web-staging/ on GitHub Pages; prod
// is either /proton-pulse-web/ or the custom domain. Local dev has no
// data dir and always reads from prod. Staging reads its own copy first
// and falls back to prod on 404 -- so a staging build without a fresh
// pipeline run still shows box art (#117).
const _IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
const _PATH_PARTS = window.location.pathname.split('/').filter(Boolean);
const _IS_STAGING = _PATH_PARTS[0] === 'proton-pulse-web-staging';
const _SITE_BASE = _IS_STAGING ? '/proton-pulse-web-staging'
                                : (_PATH_PARTS[0] === 'proton-pulse-web' ? '/proton-pulse-web' : '');
const _LOCAL_ROOT = `${window.location.origin}${_SITE_BASE}`;
const _PROD_ROOT  = 'https://www.proton-pulse.com';

function _dataUrls(filename) {
  if (_IS_LOCAL_DEV) return [`${_PROD_ROOT}/${filename}`];
  return [`${_LOCAL_ROOT}/${filename}`, `${_PROD_ROOT}/${filename}`];
}

async function _fetchWithFallback(filename) {
  const urls = _dataUrls(filename);
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch { /* try next */ }
  }
  return {};
}

let _gameImagesPromise = null;
function _loadGameImages() {
  if (!_gameImagesPromise) _gameImagesPromise = _fetchWithFallback('game-images.json');
  return _gameImagesPromise;
}

let _nonsteamImagesPromise = null;
function _loadNonsteamImages() {
  if (!_nonsteamImagesPromise) _nonsteamImagesPromise = _fetchWithFallback('nonsteam-images.json');
  return _nonsteamImagesPromise;
}

// Cache the PGWiki catalog so tier-4 (`pgwiki:` cover lookup) does not
// re-fetch it per card. Only referenced for `pgwiki:` ids -- Steam / GOG /
// Epic paths never touch this promise.
let _pgwikiCatalogPromise = null;
function _loadPgwikiCatalog() {
  if (!_pgwikiCatalogPromise) _pgwikiCatalogPromise = _fetchWithFallback('pcgwiki-catalog.json');
  return _pgwikiCatalogPromise;
}

// Cache the search index so repeated title-match probes don't re-fetch it.
// The gog/epic fallback path can run many times per page (a full library
// grid can be hundreds of cards), so memoize the promise the same way we
// do for game-images / nonsteam-images.
let _searchIndexPromise = null;
function _loadSearchIndex() {
  if (!_searchIndexPromise) _searchIndexPromise = _fetchWithFallback('search-index.json');
  return _searchIndexPromise;
}

// Same-title Steam CDN fallback for non-Steam entries (#375). Many
// multi-store titles (Cyberpunk, Divinity: Original Sin, Cities: Skylines,
// etc.) ship on both Steam and GOG/Epic. If this non-Steam entry has a
// Steam counterpart with the same normalized title, the frontend can reuse
// the Steam CDN header URL and paint a real box art instead of the "box
// art unavailable" placeholder.
//
// Returns the numeric Steam appid, or null when no match is found.
// Normalization matches search-match.js (lowercase + non-alphanumeric -> space)
// so titles that differ only in punctuation ("Divinity: Original Sin" vs
// "Divinity Original Sin") still match.
async function _findSteamAppIdByMatchingTitle(nonSteamId) {
  const idx = await _loadSearchIndex();
  if (!Array.isArray(idx)) return null;
  const source = idx.find(r => Array.isArray(r) && String(r[0]) === nonSteamId);
  if (!source) return null;
  const targetNorm = normalizeSearchable(String(source[1] || ''));
  if (!targetNorm) return null;
  const steamMatch = idx.find(r => {
    if (!Array.isArray(r)) return false;
    const rid = String(r[0]);
    if (!/^\d+$/.test(rid)) return false; // steam ids are bare digits
    return normalizeSearchable(String(r[1] || '')) === targetNorm;
  });
  return steamMatch ? String(steamMatch[0]) : null;
}

// Return the entry title from the search index for a given canonical id.
// Used by the SGDB final fallback so we can pass the game title to the
// image-refetch edge function's sgdb_search action.
async function _titleForAppId(appId) {
  const idx = await _loadSearchIndex();
  if (!Array.isArray(idx)) return '';
  const row = idx.find(r => Array.isArray(r) && String(r[0]) === appId);
  return row && row[1] ? String(row[1]) : '';
}

// SGDB final fallback (#375). When both the pipeline's nonsteam-images.json
// and the same-title Steam CDN match miss, ask the image-refetch edge fn
// to look up the title on SteamGridDB and return one widescreen grid URL.
// Cached per-session in sessionStorage so a browse grid of dozens of
// GOG/Epic covers only pays the round-trip once per unique appid.
const _SGDB_CACHE_KEY = 'pp:steam-img:sgdb-lookup:v1';
function _sgdbCacheRead(appId) {
  try {
    const raw = sessionStorage.getItem(_SGDB_CACHE_KEY);
    if (!raw) return undefined;
    const map = JSON.parse(raw);
    return map && Object.prototype.hasOwnProperty.call(map, appId) ? map[appId] : undefined;
  } catch { return undefined; }
}
function _sgdbCacheWrite(appId, urlOrNull) {
  try {
    const raw = sessionStorage.getItem(_SGDB_CACHE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[appId] = urlOrNull;
    sessionStorage.setItem(_SGDB_CACHE_KEY, JSON.stringify(map));
  } catch { /* private mode / quota -- fine, just skip cache */ }
}

async function _lookupSgdbUrlByTitle(appId, title) {
  const cached = _sgdbCacheRead(appId);
  if (cached !== undefined) return cached; // may be null (known miss)
  if (!_SUPABASE_URL || !_SUPABASE_ANON_KEY) return null;
  if (!title) { _sgdbCacheWrite(appId, null); return null; }
  const url = `${_SUPABASE_URL}/functions/v1/image-refetch`;
  // Preferred SGDB grid shapes for a widescreen hero-style card. The upstream
  // filter is a comma allowlist so any of these dimensions wins.
  const dimensions = '920x430,600x900,460x215';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_SUPABASE_ANON_KEY}`,
        'apikey': _SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        app_id: appId,
        source: 'sgdb_search',
        term: title,
        dimensions,
      }),
    });
  } catch (e) {
    console.warn('[steam-img] sgdb lookup network failure', { appId, err: String(e) });
    // Don't cache the miss on network errors -- transient. Next card gets a retry.
    return null;
  }
  if (!res.ok) {
    _sgdbCacheWrite(appId, null);
    return null;
  }
  const body = await res.json().catch(() => null);
  const first = body?.ok && Array.isArray(body?.results) && body.results.length ? body.results[0] : null;
  const picked = first?.url ? String(first.url) : null;
  _sgdbCacheWrite(appId, picked);
  return picked;
}

function _tryUrl(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function _swap(el, loaded) {
  loaded.className = el.className;
  loaded.alt = el.alt || '';
  el.parentNode?.replaceChild(loaded, el);
}

// Session-scoped route counters surfaced on the admin analytics page.
// Each fallback hit increments one bucket. Primary akamai successes are NOT
// counted here -- onerror does not fire on success, and we do not instrument
// every img tag. The admin can read totals separately and subtract.
function _bumpRoute(route) {
  const counts = window.__imgRouteCounts || (window.__imgRouteCounts = {
    cloudflare: 0,
    'game-images-json': 0,
    'nonsteam-images-json': 0,
    'steam-title-match': 0,
    'sgdb-title-match': 0,
    'pgwiki-cover': 0,
    hidden: 0,
  });
  counts[route] = (counts[route] || 0) + 1;
}

// Render a visible "box art unavailable" placeholder in place of a broken image
// slot. Runs for ANY store (Steam / GOG / Epic) once every source in the
// fallback chain has failed. Previously the slot was just hidden, which left an
// ambiguous gray gap (e.g. Battlefield 6). Replaces the <img> with a div that
// keeps the original layout classes so it occupies the same spot and size.
function _showMissing(el) {
  if (!el || !el.parentNode) return;
  const ph = document.createElement('div');
  ph.className = `${el.className ? el.className + ' ' : ''}boxart-missing`;
  if (el.dataset.appid) ph.dataset.appid = el.dataset.appid;
  ph.setAttribute('role', 'img');
  ph.setAttribute('aria-label', 'Box art unavailable');
  ph.innerHTML =
    '<svg class="boxart-missing-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 16l5-5 4 4 3-3 6 6"></path><circle cx="8.5" cy="9" r="1.4"></circle></svg>' +
    '<span>Box art unavailable</span>';
  el.replaceWith(ph);
}

// Called after the primary akamai src fails (onerror).
// Tries cloudflare, then game-images.json, then shows a Missing placeholder.
export async function loadSteamImg(el, appId) {
  const id = String(appId);

  // Non-Steam (GOG/Epic) games have no Steam CDN image. Resolve their cover
  // straight from the pipeline's nonsteam-images.json instead of walking the
  // Steam CDN chain (which would always 404 for a prefixed id).
  if (id.startsWith('gog:') || id.startsWith('epic:') || id.startsWith('pgwiki:')) {
    const nsMap = await _loadNonsteamImages();
    const nsUrl = nsMap[id];
    if (nsUrl) {
      const loaded = await _tryUrl(nsUrl);
      if (loaded) {
        console.log(`[steam-img] appId=${id} route=nonsteam-images-json`);
        _bumpRoute('nonsteam-images-json');
        _swap(el, loaded);
        return;
      }
    }
    // #375 Path 1: same-title Steam CDN fallback. Multi-store releases
    // (Cyberpunk on both Steam + GOG, etc.) share a title, and Steam has
    // the highest-quality header art. Cheap lookup: normalize the source
    // title, match against a bare-digits Steam id in the search index.
    const steamAppId = await _findSteamAppIdByMatchingTitle(id);
    if (steamAppId) {
      const url = _CDN2(steamAppId);
      const loaded = await _tryUrl(url);
      if (loaded) {
        console.log(`[steam-img] appId=${id} route=steam-title-match steamAppId=${steamAppId}`);
        _bumpRoute('steam-title-match');
        _swap(el, loaded);
        return;
      }
    }
    // #375 final fallback: SteamGridDB via the anonymous image-refetch
    // edge fn. Only fires when the previous tiers all missed. Cached per
    // session so a browse grid of many non-Steam cards only pays the
    // round-trip once per unique appid.
    const title = await _titleForAppId(id);
    const sgdbUrl = await _lookupSgdbUrlByTitle(id, title);
    if (sgdbUrl) {
      const loaded = await _tryUrl(sgdbUrl);
      if (loaded) {
        console.log(`[steam-img] appId=${id} route=sgdb-title-match`);
        _bumpRoute('sgdb-title-match');
        _swap(el, loaded);
        return;
      }
    }
    // #375 tier 4 (final resort). PGWiki-only entries carry a `cover_url`
    // in pcgwiki-catalog.json (pipeline slice 3.5). Portrait product-shot
    // rather than widescreen hero art, so we only reach for it when the
    // better sources all missed. Only fires for `pgwiki:` ids -- GOG / Epic
    // never had a PGWiki cover to begin with.
    let pgwikiCoverUrl = null;
    if (id.startsWith('pgwiki:')) {
      const catalog = await _loadPgwikiCatalog();
      const cover = catalog && catalog[id] && catalog[id].cover_url;
      if (cover && String(cover).startsWith('https://images.pcgamingwiki.com/')) {
        pgwikiCoverUrl = String(cover);
        const loaded = await _tryUrl(pgwikiCoverUrl);
        if (loaded) {
          console.log(`[steam-img] appId=${id} route=pgwiki-cover`);
          _bumpRoute('pgwiki-cover');
          _swap(el, loaded);
          return;
        }
      }
    }
    console.warn(`[steam-img] appId=${id} no non-Steam cover available (exhausted nonsteam-json, steam-title-match, sgdb, pgwiki-cover)`);
    _bumpRoute('hidden');
    _reportMissingImage(id, nsUrl || sgdbUrl || pgwikiCoverUrl || '');
    _showMissing(el);
    return;
  }

  const cdn2 = await _tryUrl(_CDN2(id));
  if (cdn2) {
    console.log(`[steam-img] appId=${id} route=cloudflare`);
    _bumpRoute('cloudflare');
    _swap(el, cdn2);
    return;
  }

  const map = await _loadGameImages();
  const url = map[id];
  if (url) {
    const loaded = await _tryUrl(url);
    if (loaded) {
      console.log(`[steam-img] appId=${id} route=game-images-json`);
      _bumpRoute('game-images-json');
      _swap(el, loaded);
      return;
    }
  }

  console.warn(`[steam-img] appId=${id} all CDN paths exhausted`);
  _bumpRoute('hidden');
  _reportMissingImage(id, map[id] || _CDN2(id));
  _showMissing(el);
}

// Global bridge for inline onerror="window.__steamImgLoad(this)".
// img elements must carry data-appid="${appId}".
window.__steamImgLoad = el => {
  const appId = el.dataset.appid;
  if (appId) loadSteamImg(el, appId);
  else el.style.visibility = 'hidden';
};
