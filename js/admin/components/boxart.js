// Admin "Box Art Manager" tab.
//
// Merged view of every game in search-index.json with the per-store
// image caches (game-images.json for Steam fallbacks, nonsteam-images.json
// for GOG / Epic). Filters mirror the Reports admin tab layout so it
// feels consistent. Per row:
//   - Game title hyperlinks to /app.html#/app/<id> so an admin can
//     jump straight to the game page (or stub if no reports yet).
//   - Probe: HEADs the canonical URL for the row.
//   - Refetch: hits the store's canonical API (Steam appdetails) and
//     reports the working URL or a human-readable error.
// Batch: "Probe all (visible)" walks the current page sequentially;
// "Probe all (filtered)" walks every row that matches the current
// filters in bounded batches so the browser stays responsive.

import { dataUrl } from '../../lib/data-url.js?v=0de73aed';
import { escapeHtml } from '../utils.js?v=2668b2f0';
import {
  probeImageUrl,
  probeSteamHeader, refetchSteamHeader, refetchNonSteamHeader, refetchSgdbHeader, searchSgdb,
  confirmBoxArtOk, listBoxArtConfirmations,
  setBoxArtOverride, uploadBoxArtOverride, clearBoxArtOverride, listBoxArtOverrides,
} from '../api/boxart.js?v=d0ed4be0';

// Verify a URL actually loads in the browser via <img>. Refetch (#351)
// uses this to catch the case where Steam appdetails returns a URL that
// server-side HEAD says is 200 but the browser's <img> element fails to
// render (redirect chain that ends in 404, region-locked CDN edge, etc).
// Same shape as the batch-probe helper defined inside renderBoxartAdmin,
// hoisted to module scope so the detail view can reuse it.
function _imgLoadsBrowser(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; resolve(false); }, timeoutMs);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
}

// Build the Steam-CDN fallback ladder for a refetch URL that didn't
// load in-browser. Order matches _resolveCurrentLive's server-side
// probe (Akamai -> Fastly -> Cloudflare) with a host-swap of the
// original URL prepended so a hashed appdetails path gets tried on
// both Akamai and Fastly before we drop to the plain header.jpg paths.
//
// Host comparisons parse the URL and check `.hostname` exactly rather
// than doing a substring `includes()` -- substring matching would fire
// on `https://evil.example/?redirect=shared.akamai.steamstatic.com/...`
// which is the CodeQL "incomplete URL substring sanitization" pattern.
function _steamRefetchFallbacks(originalUrl, appId) {
  const enc = encodeURIComponent(appId);
  const list = [];
  let parsed = null;
  try { parsed = originalUrl ? new URL(originalUrl) : null; } catch { parsed = null; }
  if (parsed && parsed.hostname === 'shared.akamai.steamstatic.com') {
    parsed.hostname = 'shared.fastly.steamstatic.com';
    list.push(parsed.toString());
  } else if (parsed && parsed.hostname === 'shared.fastly.steamstatic.com') {
    parsed.hostname = 'shared.akamai.steamstatic.com';
    list.push(parsed.toString());
  }
  list.push(
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${enc}/header.jpg`,
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${enc}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${enc}/header.jpg`,
  );
  return list.filter((u) => u && u !== originalUrl);
}

// Strip trademark / registered / service-mark symbols (and collapse the
// whitespace they leave behind) from a store title so it works as a
// SteamGridDB search term. "Battlefield(TM) 6" -> "Battlefield 6".
function _cleanTitle(t) {
  return String(t || '').replace(/[™®℠]/g, ' ').replace(/\s+/g, ' ').trim();
}

const PAGE_SIZE = 25;
const BATCH_SIZE = 10;              // parallel probes per batch when Probe all runs
const BATCH_YIELD_MS = 50;          // pause between batches so the UI stays responsive

let _cache = null;
async function _loadIndexes() {
  if (_cache) return _cache;
  const [siRes, giRes, gcRes, nsRes, nscRes, overrides, clientErrors, confirmations, extRes] = await Promise.all([
    fetch(await dataUrl('search-index.json')).catch(() => null),
    fetch(await dataUrl('game-images.json')).catch(() => null),
    fetch(await dataUrl('game-images-cache.json')).catch(() => null),
    fetch(await dataUrl('nonsteam-images.json')).catch(() => null),
    fetch(await dataUrl('nonsteam-images-cache.json')).catch(() => null),
    listBoxArtOverrides().catch(() => ({ ok: false, rows: [] })),
    _fetchClientImageErrors().catch(() => []),
    listBoxArtConfirmations().catch(() => ({ ok: false, rows: [] })),
    // #363: the long-tail Steam catalog. Games like Cat Chess (4163030) are only
    // here, not in the main search-index, so without it an admin cannot find them
    // to fix their box art. Same [appId, title, "", 0, 0, "steam"] row shape.
    fetch(await dataUrl('search-index-steam-extended.json')).catch(() => null),
  ]);
  const searchIndex = (siRes && siRes.ok) ? await siRes.json().catch(() => []) : [];
  const extendedIndex = (extRes && extRes.ok) ? await extRes.json().catch(() => []) : [];
  const gameImages  = (giRes && giRes.ok) ? await giRes.json().catch(() => ({})) : {};
  const nonSteam    = (nsRes && nsRes.ok) ? await nsRes.json().catch(() => ({})) : {};
  const cacheRaw    = (gcRes && gcRes.ok) ? await gcRes.json().catch(() => ({})) : {};
  const nsCacheRaw  = (nscRes && nscRes.ok) ? await nscRes.json().catch(() => ({})) : {};
  // game-images-cache.json is the pipeline's authoritative status per Steam
  // appid. status "missing" and "delisted" both mean the standard Steam CDN
  // has nothing usable AND we couldn't find a fallback -- these are the games
  // the frontend currently shows the literal "Box art missing" text for. Pull
  // the appids into a Set so _deriveStatus can flip Steam entries from the
  // optimistic "default_cdn" to "missing" (#199 follow-up).
  const knownMissingSteam = new Set();
  for (const [aid, entry] of Object.entries(cacheRaw)) {
    const status = entry?.status;
    if (status === 'missing' || status === 'delisted') knownMissingSteam.add(String(aid));
  }
  // Client-side onerror reports from image_load_errors: covers runtime 404s
  // for any storefront (Steam CDN drift, GOG/Epic catalog rot). Merged into
  // both known-missing Sets so admin picks up broken art users are actually
  // seeing right now. (#199 follow-up)
  //
  // For Steam entries the pipeline probes the standard CDN directly and writes
  // game-images-cache.json, so a single stray onerror from a browser extension
  // or a flaky mobile connection should NOT override the pipeline's verdict on
  // a popular game (#279: TF2 / DayZ / Hearts of Iron IV surfaced under the
  // "no working source" filter despite their box art loading fine). Require a
  // persistent signal -- MIN_STEAM_CLIENT_HITS distinct hits from at least a
  // few users -- before believing the client report over the pipeline. For
  // GOG / Epic there is no cheap pipeline probe yet, so any client error is
  // still worth surfacing.
  const MIN_STEAM_CLIENT_HITS = 3;
  const knownMissingNonSteam = new Set();
  for (const row of (clientErrors || [])) {
    const aid = String(row?.app_id || '');
    if (!aid) continue;
    if (aid.startsWith('gog:') || aid.startsWith('epic:')) {
      knownMissingNonSteam.add(aid);
    } else {
      const hits = Number(row?.hit_count || 0);
      if (hits >= MIN_STEAM_CLIENT_HITS) knownMissingSteam.add(aid);
    }
  }
  // Pipeline probe results for non-Steam covers (#203). nonsteam-images-cache.json
  // is written by nonsteam_images_probe.py, one entry per GOG/Epic id with
  // { url, status, probed_at }. Missing status means the URL HEAD-checked as
  // 404 during the last pipeline run. Merged with the client-error set so
  // admins see broken non-Steam covers even if no user has hit that card yet.
  for (const [aid, entry] of Object.entries(nsCacheRaw)) {
    if (entry?.status === 'missing') knownMissingNonSteam.add(String(aid));
  }
  // Admin overrides beat all other sources; keyed by app_id for O(1)
  // lookup during row build + status render.
  const overrideMap = {};
  for (const row of (overrides.rows || [])) {
    if (row?.app_id) overrideMap[String(row.app_id)] = row;
  }
  // Admin reprobe confirmations (#270): appids the admin already probed
  // and got an OK on. Subtract from both known-missing Sets so the row
  // doesn't come back under the missing filter after a refresh.
  const confirmedOk = new Set();
  for (const row of (confirmations.rows || [])) {
    if (row?.app_id) confirmedOk.add(String(row.app_id));
  }
  for (const aid of confirmedOk) {
    knownMissingSteam.delete(aid);
    knownMissingNonSteam.delete(aid);
  }
  _cache = { searchIndex, extendedIndex, gameImages, nonSteam, overrideMap, knownMissingSteam, knownMissingNonSteam, confirmedOk };
  return _cache;
}

// Pull recent client-side image_load_errors rows via the anon REST endpoint.
// Public-read RLS is intentional: this is telemetry, not sensitive data, and
// the admin bundle already runs unauthenticated for other public reads.
async function _fetchClientImageErrors() {
  const url = window.SUPABASE_URL || 'https://ilsgdshkaocrmibwdezk.supabase.co';
  const key = window.SUPABASE_ANON_KEY || '';
  if (!key) return [];
  const r = await fetch(`${url}/rest/v1/image_load_errors?select=app_id,store_type,hit_count,last_seen&order=last_seen.desc&limit=2000`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return [];
  return await r.json().catch(() => []);
}

// Derive the same status the Status column shows, without probing.
// Admin override beats everything; otherwise the presence of a cached
// URL and store type determine the label.
function _deriveStatus(type, appId, cachedUrl, hasOverride, knownMissingSteam, knownMissingNonSteam) {
  if (hasOverride) return 'override';
  if (type === 'steam') {
    // Pipeline flagged this Steam entry as unfixable (no standard CDN, no
    // SGDB fallback). Client renders the literal "Box art missing" tile for
    // these, so admin should surface them under the missing filter (#199).
    if (knownMissingSteam && knownMissingSteam.has(appId)) return 'missing';
    return cachedUrl ? 'fallback_cached' : 'default_cdn';
  }
  // Non-Steam: pipeline records a URL as long as the catalog API returned one,
  // so cachedUrl presence isn't proof the URL still works. Client-side onerror
  // reports (image_load_errors) fill that gap for GOG/Epic (#199 follow-up).
  if (knownMissingNonSteam && knownMissingNonSteam.has(appId)) return 'missing';
  return cachedUrl ? 'cached' : 'missing';
}

// search-index shape: [appId, title, tier, pdb, pulse, appType, releaseYear, delisted, adult]
function _buildRows({ searchIndex, extendedIndex, gameImages, nonSteam, overrideMap, knownMissingSteam, knownMissingNonSteam }, { store, textFilter, scope, status }) {
  const q = String(textFilter || '').trim().toLowerCase();
  const rows = [];
  const seen = new Set();
  const pushRow = (row) => {
    if (!Array.isArray(row) || row.length < 6) return;
    const appId = String(row[0]);
    if (seen.has(appId)) return;
    const title = String(row[1] || '');
    const type  = row[5] || (appId.startsWith('gog:') ? 'gog' : appId.startsWith('epic:') ? 'epic' : 'steam');
    if (store && store !== 'all' && store !== type) return;
    if (q && !title.toLowerCase().includes(q) && !appId.startsWith(q)) return;
    const override = overrideMap ? overrideMap[appId] : null;
    let cachedUrl = null;
    if (type === 'steam') cachedUrl = gameImages[appId] || null;
    else                   cachedUrl = nonSteam[appId] || null;
    const derivedStatus = _deriveStatus(type, appId, cachedUrl, !!override, knownMissingSteam, knownMissingNonSteam);
    // scope filter: has = row is presumed to display box art
    // (Steam default CDN OR any cached URL OR override). missing =
    // only rows we know don't display box art (non-Steam with no
    // cached URL, no override, and no store CDN fallback).
    if (scope === 'has'     && derivedStatus === 'missing') return;
    if (scope === 'missing' && derivedStatus !== 'missing') return;
    // status filter: exact match against derived status label.
    if (status && status !== 'all' && status !== derivedStatus) return;
    seen.add(appId);
    rows.push({ appId, title, type, cachedUrl, derivedStatus, override });
  };
  for (const row of searchIndex) pushRow(row);
  // #363: only when the admin is actually searching, fold in matching long-tail
  // Steam games from the extended index (deduped against the main index). Skipped
  // when browsing so we never render all 144k rows.
  if (q && Array.isArray(extendedIndex)) {
    for (const row of extendedIndex) pushRow(row);
  }
  return rows;
}

// Initial status derived from what we already know without probing.
// The pipeline only writes to game-images.json / nonsteam-images.json
// when it had to resolve or fall back to something, so presence tells
// us a lot:
//   - Steam + cached URL   -> pipeline saved a fallback (standard CDN 404'd at build time)
//   - Steam + no cached    -> standard Steam CDN presumed working (default state, not yet re-probed)
//   - non-Steam + cached   -> we have a URL from the store's catalog
//   - non-Steam + no cache -> genuinely missing (no store CDN fallback available)
function _initialStatusHtml(r) {
  if (r.override) {
    const src = String(r.override.source || 'manual');
    return `<span class="admin-badge admin-badge--ok" title="Admin override (${escapeHtml(src)}) -- pipeline preserves this on every run">Admin override</span>`;
  }
  if (r.type === 'steam') {
    if (r.cachedUrl) return '<span class="admin-badge admin-badge--info" title="Pipeline stored a hashed fallback URL (standard CDN 404\'d at build time)">Fallback cached</span>';
    return '<span class="admin-badge admin-badge--muted" title="No fallback needed; standard Steam CDN presumed working. Click Probe to verify.">Default CDN</span>';
  }
  if (r.cachedUrl) return '<span class="admin-badge admin-badge--info" title="Cached URL from the store\'s catalog">Cached</span>';
  return '<span class="admin-badge admin-badge--warn" title="No cached URL and no standard CDN pattern for this store">Missing</span>';
}

function _renderShell() {
  return `
    <div class="admin-filters">
      <input type="text" id="boxart-search" class="admin-input admin-input--wide" placeholder="Search by app ID or title...">
      <select id="boxart-store" class="admin-select">
        <option value="all">All stores</option>
        <option value="steam">Steam</option>
        <option value="gog">GOG</option>
        <option value="epic">Epic</option>
      </select>
      <select id="boxart-scope" class="admin-select" title="Coarse filter: whether the row is expected to show box art">
        <option value="all">All entries</option>
        <option value="has">Has box art (default CDN or cached URL)</option>
        <option value="missing">Missing box art (no working source)</option>
      </select>
      <select id="boxart-status" class="admin-select" title="Fine filter: match the exact status column value">
        <option value="all">Any status</option>
        <option value="override">Admin override</option>
        <option value="default_cdn">Default CDN (Steam, no fallback saved)</option>
        <option value="fallback_cached">Fallback cached (Steam, pipeline saved URL)</option>
        <option value="cached">Cached (GOG/Epic with catalog URL)</option>
        <option value="missing">Missing (GOG/Epic with no URL)</option>
      </select>
      <details class="admin-dropdown" id="boxart-actions">
        <summary class="admin-btn admin-btn--primary">Actions <span class="admin-dropdown-caret">▾</span></summary>
        <div class="admin-dropdown-menu">
          <button class="admin-dropdown-item" id="boxart-probe-visible-btn" title="Probe every row on the current page">Probe visible page</button>
          <button class="admin-dropdown-item" id="boxart-probe-all-btn" title="Probe every row that matches the current filters in bounded batches">Probe all (filtered)</button>
          <button class="admin-dropdown-item" id="boxart-sgdb-first-all-btn" title="Search SteamGridDB by title for every filtered row and set the first widescreen grid as the override. Skips rows that already have an override.">Set first SGDB result (filtered)</button>
          <button class="admin-dropdown-item" id="boxart-steamcdn-header-all-btn" title="For every filtered Steam row, probe the Steam CDN wide-aspect variants (header, capsule sizes, library_hero) and set the first one that loads as the override. Skips non-Steam rows and rows that already have an override.">Set first Steam CDN wide image (filtered)</button>
          <button class="admin-dropdown-item admin-dropdown-item--danger" id="boxart-cancel-btn" hidden>Cancel batch</button>
        </div>
      </details>
    </div>
    <p class="admin-hint" style="margin:8px 0 12px">
      Loads search-index.json + game-images.json + nonsteam-images.json + box_art_overrides in this browser.
      Probe HEADs the canonical URL. Refetch asks the store's API (Steam appdetails / SGDB) for the current URL.
      Set URL and Upload write to box_art_overrides -- the pipeline preserves those on every rerun. Clear removes the override.
    </p>
    <!-- Modal + file input live in admin.html so both list + detail views share them. -->
    <div id="boxart-loading" class="admin-loading">Loading indexes...</div>
    <div id="boxart-batch-progress" class="admin-counts" hidden></div>
    <div id="boxart-count" class="admin-counts" hidden></div>
    <div class="admin-table-scroll">
      <table id="boxart-table" class="admin-table" hidden>
        <thead>
          <tr>
            <th>Game</th>
            <th>Store</th>
            <th>ID</th>
            <th>Cached URL</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="boxart-tbody"></tbody>
      </table>
    </div>
    <div id="boxart-pager" class="admin-pager" hidden></div>
  `;
}

// Route to the same /app/<id> URL the search dropdown uses. Non-Steam
// ids are already prefixed (gog:xxx / epic:xxx) so the router handles
// them the same way; on a game with no reports the page falls back to
// the stub view (title + Submit CTA).
function _appHref(appId) {
  return `app.html#/app/${encodeURIComponent(appId)}`;
}

// Direct link to the store page for the game. Steam has the numeric id
// so we can point straight at the product page; GOG / Epic carry only
// the canonical id (no slug in the frontend index) so we fall back to
// a title search on the store which reliably lands on the product.
function _storeHref(type, appId, title) {
  if (type === 'steam') {
    const num = String(appId).replace(/[^0-9]/g, '');
    return num ? `https://store.steampowered.com/app/${num}/` : null;
  }
  const q = encodeURIComponent(title || '');
  if (!q) return null;
  if (type === 'gog')  return `https://www.gog.com/en/games?query=${q}`;
  if (type === 'epic') return `https://store.epicgames.com/en-US/browse?q=${q}&sortBy=relevancy&sortDir=DESC`;
  return null;
}

function _renderRow(r) {
  const cachedCell = r.cachedUrl
    ? `<a href="${escapeHtml(r.cachedUrl)}" target="_blank" rel="noopener" class="admin-link" title="${escapeHtml(r.cachedUrl)}">cached</a>`
    : '<span class="admin-muted">(none)</span>';
  const titleHtml = escapeHtml(r.title || '(no title)');
  const storeHref = _storeHref(r.type, r.appId, r.title);
  const storeBadge = `<span class="admin-badge admin-badge--info">${r.type}</span>`;
  const storeCell = storeHref
    ? `<a href="${escapeHtml(storeHref)}" target="_blank" rel="noopener" class="admin-link" title="Open on ${escapeHtml(r.type)} store">${storeBadge}</a>`
    : storeBadge;
  return `
    <tr data-appid="${escapeHtml(r.appId)}" data-store="${escapeHtml(r.type)}" data-cached="${escapeHtml(r.cachedUrl || '')}">
      <td class="admin-col-title">
        <a href="${_appHref(r.appId)}" target="_blank" rel="noopener" class="admin-link admin-user-name-link">${titleHtml}</a>
      </td>
      <td>${storeCell}</td>
      <td><code>${escapeHtml(r.appId)}</code></td>
      <td>${cachedCell}</td>
      <td class="boxart-status">${_initialStatusHtml(r)}</td>
      <td>
        <a class="admin-btn admin-btn--primary" href="?boxart=${encodeURIComponent(r.appId)}" data-action="details" title="Open the detail view with all URL sources + action buttons">Details</a>
      </td>
    </tr>`;
}

function _renderPage(rows, page) {
  const total = rows.length;
  const start = page * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById('boxart-tbody');
  const table = document.getElementById('boxart-table');
  const countEl = document.getElementById('boxart-count');
  if (!tbody) return;
  tbody.innerHTML = slice.map(_renderRow).join('') || `<tr><td colspan="6" class="admin-empty">No games match the current filters.</td></tr>`;
  table.hidden = false;
  countEl.textContent = total
    ? `${total.toLocaleString()} game(s) match \u00b7 showing ${start + 1}-${Math.min(start + PAGE_SIZE, total)}`
    : '0 games match the current filters';
  countEl.hidden = false;
  _renderPager(total, page);
}

function _renderPager(total, page) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pager = document.getElementById('boxart-pager');
  if (!pager) return;
  if (pages <= 1) { pager.hidden = true; return; }
  const prevDisabled = page <= 0 ? 'disabled' : '';
  const nextDisabled = page >= pages - 1 ? 'disabled' : '';
  pager.innerHTML = `
    <button class="admin-btn" data-page-action="prev" ${prevDisabled}>Prev</button>
    <span class="admin-muted" style="margin:0 10px">Page ${page + 1} of ${pages}</span>
    <button class="admin-btn" data-page-action="next" ${nextDisabled}>Next</button>
  `;
  pager.hidden = false;
}

// Persist a successful probe result so the row does not resurface under
// the missing filter after a refresh (#270). Fire-and-forget: any auth
// error just leaves the row as-is (same behavior as before this fix).
function _persistConfirmedOk(appId, result) {
  if (!result?.ok || !appId) return;
  confirmBoxArtOk(appId, result.url || '').then((res) => {
    if (!res?.ok) console.debug('[boxart] confirm_ok failed', { appId, status: res?.status, error: res?.error });
  }).catch(() => { /* swallow -- best-effort */ });
}

async function _probeRow(tr, gameImages) {
  const appId = tr.dataset.appid;
  const type  = tr.dataset.store;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">probing...</span>';
  const result = type === 'steam'
    ? await probeSteamHeader(appId, gameImages[appId] || null)
    : await refetchNonSteamHeader(appId, tr.dataset.cached || null);
  _paintStatus(statusEl, result);
  _persistConfirmedOk(appId, result);
  return result;
}

async function _refetchRow(tr) {
  const appId = tr.dataset.appid;
  const type  = tr.dataset.store;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">refetching from source...</span>';
  const result = type === 'steam'
    ? await refetchSteamHeader(appId)
    : await refetchNonSteamHeader(appId, tr.dataset.cached || null);
  _paintStatus(statusEl, result);
  _persistConfirmedOk(appId, result);
  return result;
}

async function _sgdbRow(tr) {
  const appId = tr.dataset.appid;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">fetching from SteamGridDB...</span>';
  const result = await refetchSgdbHeader(appId);
  _paintStatus(statusEl, result);
  _persistConfirmedOk(appId, result);
  return result;
}

function _paintStatus(el, result) {
  if (!el) return;
  if (result.ok) {
    el.innerHTML = `<span class="admin-badge admin-badge--ok">Box art OK</span> <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener" class="admin-link" title="${escapeHtml(result.url)}">view</a>`;
  } else {
    const status = result.status ? ` (HTTP ${result.status})` : '';
    el.innerHTML = `<span class="admin-badge admin-badge--warn">Missing</span> <span class="admin-muted" title="${escapeHtml(result.error || 'unknown')}">${escapeHtml((result.error || 'unknown') + status)}</span>`;
  }
}

// Probe a full filtered set in bounded batches. Only rows on the current
// visible page have DOM elements to paint into; off-page rows are still
// probed and their results held in memory so the summary count is
// correct. cancelToken lets the admin abort mid-batch.
async function _probeAllFiltered(rows, gameImages, page, pageSize, cancelToken, onProgress) {
  const total = rows.length;
  const okCount = { n: 0 };
  const failCount = { n: 0 };
  const start = page * pageSize;
  const end   = Math.min(start + pageSize, rows.length);
  const visibleTbody = document.getElementById('boxart-tbody');

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (cancelToken.cancelled) break;
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (r, j) => {
      const absoluteIdx = i + j;
      const result = r.type === 'steam'
        ? await probeSteamHeader(r.appId, gameImages[r.appId] || null)
        : await refetchNonSteamHeader(r.appId, r.cachedUrl || null);
      r._probe = result;
      if (result.ok) okCount.n += 1; else failCount.n += 1;
      // Persist success across the whole batch too (#270).
      _persistConfirmedOk(r.appId, result);
      // Paint the visible row's status cell if this row is on-screen.
      if (visibleTbody && absoluteIdx >= start && absoluteIdx < end) {
        const tr = visibleTbody.querySelector(`tr[data-appid="${CSS.escape(r.appId)}"]`);
        if (tr) _paintStatus(tr.querySelector('.boxart-status'), result);
      }
    }));
    onProgress(Math.min(i + BATCH_SIZE, total), total, okCount.n, failCount.n);
    // Yield to keep the UI responsive between batches.
    await new Promise(res => setTimeout(res, BATCH_YIELD_MS));
  }
  return { total, ok: okCount.n, fail: failCount.n, cancelled: cancelToken.cancelled };
}

export async function renderBoxartAdmin() {
  const content = document.getElementById('boxart-content');
  if (!content) return;
  content.innerHTML = _renderShell();

  let indexes;
  try {
    indexes = await _loadIndexes();
  } catch (e) {
    content.innerHTML = `<p class="admin-error">Failed to load indexes: ${escapeHtml(e.message || String(e))}</p>`;
    return;
  }
  document.getElementById('boxart-loading').hidden = true;

  // Filter state loaded from URL query params so refresh + browser back
  // both restore whatever was last active (user request: retain filters
  // across the detail-page round-trip and reloads).
  const _initialParams = new URLSearchParams(window.location.search);
  const state = {
    store:      _initialParams.get('bxs') || 'all',
    textFilter: _initialParams.get('bxq') || '',
    scope:      _initialParams.get('bxsc') || 'all',
    status:     _initialParams.get('bxst') || 'all',
    page:       Math.max(0, parseInt(_initialParams.get('bxp') || '0', 10) || 0),
    rows: [],
  };
  let cancelToken = { cancelled: false };

  // Write current filter state back into the URL (replaceState, no history
  // spam). Keeps other tab query params intact (e.g. ?tab=boxart).
  function _syncStateToUrl() {
    const p = new URLSearchParams(window.location.search);
    // Boxart-manager-scoped keys are `bx*` so they don't collide with
    // other admin tabs' params.
    const set = (k, v, dflt) => (v && v !== dflt) ? p.set(k, v) : p.delete(k);
    set('bxs',  state.store,      'all');
    set('bxq',  state.textFilter, '');
    set('bxsc', state.scope,      'all');
    set('bxst', state.status,     'all');
    set('bxp',  state.page > 0 ? String(state.page) : '', '');
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  }

  function refilter() {
    state.rows = _buildRows(indexes, {
      store: state.store,
      textFilter: state.textFilter,
      scope: state.scope,
      status: state.status,
    });
    state.page = 0;
    _syncStateToUrl();
    _renderPage(state.rows, state.page);
  }

  const searchEl  = document.getElementById('boxart-search');
  const storeEl   = document.getElementById('boxart-store');
  const scopeEl   = document.getElementById('boxart-scope');
  const statusEl  = document.getElementById('boxart-status');
  const visBtn    = document.getElementById('boxart-probe-visible-btn');
  const allBtn    = document.getElementById('boxart-probe-all-btn');
  const sgdbAllBtn = document.getElementById('boxart-sgdb-first-all-btn');
  const steamCdnAllBtn = document.getElementById('boxart-steamcdn-header-all-btn');
  const cancelBtn = document.getElementById('boxart-cancel-btn');
  const actionsDropdown = document.getElementById('boxart-actions');
  // Close the dropdown after any menu-item click so it doesn't stay open
  // while a batch runs. `open` toggles are the source of truth on <details>.
  const _closeActions = () => { if (actionsDropdown) actionsDropdown.open = false; };
  // Viewport-aware alignment: when the summary button sits close enough to
  // the right edge that the 220px-min menu would overflow the viewport,
  // flip to right-anchor via data-align. On narrow mobile screens the
  // filter row wraps and the button lands on the LEFT, so we keep the
  // default left-anchor there. Recomputed on every open so viewport
  // resize + orientation flip stay correct.
  const _alignActions = () => {
    if (!actionsDropdown || !actionsDropdown.open) return;
    const summary = actionsDropdown.querySelector('summary');
    if (!summary) return;
    const r = summary.getBoundingClientRect();
    const menuWidth = 240; // min-width 220 + padding
    const viewport = window.innerWidth;
    // If the menu (if left-anchored to the button's left edge) would
    // extend past the right edge with a 12px gutter, use right-anchor.
    // Otherwise left-anchor.
    const overflowsRight = r.left + menuWidth > viewport - 12;
    actionsDropdown.dataset.align = overflowsRight ? 'right' : 'left';
  };
  if (actionsDropdown) {
    actionsDropdown.addEventListener('toggle', _alignActions);
    window.addEventListener('resize', _alignActions);
  }
  // Click outside the dropdown closes it too.
  document.addEventListener('click', (e) => {
    if (!actionsDropdown) return;
    if (!actionsDropdown.contains(e.target)) actionsDropdown.open = false;
  });
  const progEl    = document.getElementById('boxart-batch-progress');
  const table     = document.getElementById('boxart-table');
  const pager     = document.getElementById('boxart-pager');

  // Restore the input values from state (URL) so the controls match what
  // was filtered before the round-trip / reload.
  if (searchEl && state.textFilter) searchEl.value = state.textFilter;
  if (storeEl)  storeEl.value  = state.store;
  if (scopeEl)  scopeEl.value  = state.scope;
  if (statusEl) statusEl.value = state.status;

  let debounce = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.textFilter = searchEl.value; refilter(); }, 200);
  });
  storeEl.addEventListener('change', () => { state.store = storeEl.value; refilter(); });
  scopeEl.addEventListener('change', () => { state.scope = scopeEl.value; refilter(); });
  statusEl.addEventListener('change', () => { state.status = statusEl.value; refilter(); });

  function setBatchRunning(running) {
    visBtn.disabled = running;
    allBtn.disabled = running;
    if (sgdbAllBtn) sgdbAllBtn.disabled = running;
    if (steamCdnAllBtn) steamCdnAllBtn.disabled = running;
    cancelBtn.hidden = !running;
    progEl.hidden = !running;
  }

  visBtn.addEventListener('click', async () => {
    _closeActions();
    setBatchRunning(true);
    cancelToken = { cancelled: false };
    try {
      const trs = Array.from(table.querySelectorAll('tbody tr'));
      let done = 0, ok = 0, fail = 0;
      for (const tr of trs) {
        if (cancelToken.cancelled) break;
        const result = await _probeRow(tr, indexes.gameImages);
        done += 1;
        if (result.ok) ok += 1; else fail += 1;
        progEl.textContent = `Probing visible: ${done} / ${trs.length} \u00b7 ${ok} ok / ${fail} fail`;
      }
      progEl.textContent = `Done: ${done} probed \u00b7 ${ok} ok / ${fail} fail${cancelToken.cancelled ? ' (cancelled)' : ''}`;
    } finally {
      setBatchRunning(false);
      progEl.hidden = false;   // keep the summary visible
    }
  });

  allBtn.addEventListener('click', async () => {
    _closeActions();
    if (!state.rows.length) return;
    if (state.rows.length > 200 && !confirm(`Probe ${state.rows.length.toLocaleString()} rows? This runs in ${BATCH_SIZE}-row batches and can take a while.`)) return;
    setBatchRunning(true);
    cancelToken = { cancelled: false };
    try {
      progEl.textContent = `Probing 0 / ${state.rows.length}...`;
      const summary = await _probeAllFiltered(
        state.rows, indexes.gameImages, state.page, PAGE_SIZE, cancelToken,
        (done, total, ok, fail) => {
          progEl.textContent = `Probing: ${done} / ${total} \u00b7 ${ok} ok / ${fail} fail`;
        },
      );
      progEl.textContent = `Done: ${summary.total} probed \u00b7 ${summary.ok} ok / ${summary.fail} fail${summary.cancelled ? ' (cancelled)' : ''}`;
    } finally {
      setBatchRunning(false);
      progEl.hidden = false;
    }
  });

  // Batch "Set first SGDB result" across every filtered row. Skips rows
  // that already have an admin override so a re-run does not clobber
  // manual choices. Runs sequentially with a small yield so the UI stays
  // responsive and SGDB does not rate-limit us into oblivion.
  if (sgdbAllBtn) sgdbAllBtn.addEventListener('click', async () => {
    _closeActions();
    if (!state.rows.length) return;
    const total = state.rows.length;
    if (!confirm(`Search SteamGridDB by title for ${total.toLocaleString()} row${total === 1 ? '' : 's'} and set the first widescreen grid as the override on each?\n\nRows that already have an admin override are skipped. This can take a while.`)) return;
    setBatchRunning(true);
    cancelToken = { cancelled: false };
    let done = 0, ok = 0, skip = 0, fail = 0;
    try {
      progEl.textContent = `SGDB first: 0 / ${total}...`;
      for (const r of state.rows) {
        if (cancelToken.cancelled) break;
        done += 1;
        if (r.override?.image_url) { skip += 1; }
        else {
          const term = _cleanTitle(r.title);
          let sr = await searchSgdb(r.appId, term, '460x215,920x430');
          if (!sr?.ok || !Array.isArray(sr.results) || sr.results.length === 0) {
            sr = await searchSgdb(r.appId, term, '');
          }
          const pick = (sr?.ok && Array.isArray(sr.results)) ? (sr.results.find((g) => g.url) || sr.results[0]) : null;
          if (pick?.url) {
            const applied = await setBoxArtOverride(r.appId, pick.url);
            if (applied.ok) {
              r.override = { image_url: pick.url, source: 'manual' };
              if (indexes.overrideMap) indexes.overrideMap[r.appId] = r.override;
              ok += 1;
            } else { fail += 1; }
          } else { fail += 1; }
          // 250ms breather between rows to stay well under SGDB's rate limits.
          await new Promise((res) => setTimeout(res, 250));
        }
        progEl.textContent = `SGDB first: ${done} / ${total} \u00b7 ${ok} set / ${skip} skipped / ${fail} failed`;
      }
      progEl.textContent = `Done: ${done} scanned \u00b7 ${ok} set / ${skip} skipped / ${fail} failed${cancelToken.cancelled ? ' (cancelled)' : ''}`;
    } finally {
      setBatchRunning(false);
      progEl.hidden = false;
      // Re-render so the freshly-set overrides show up in the Status column.
      _renderPage(state.rows, state.page);
    }
  });

  // Batch "Set Steam CDN wide image (filtered)": for every filtered Steam
  // row, probe the wide-aspect Steam CDN variants in preference order and
  // use the first one that loads. Falls back to any wide variant when
  // header.jpg is missing so games without the standard header (rare, but
  // does happen with older or region-limited apps) still get an override.
  // Cheap: just <img> loads, no third-party API in the loop. Skips
  // non-Steam rows and any row that already has an override.
  const STEAM_CDN_WIDE_PREF = [
    'header.jpg',
    'capsule_616x353.jpg',
    'capsule_467x181.jpg',
    'capsule_231x87.jpg',
    'library_hero.jpg',
  ];
  const _imgLoads = (url, timeoutMs = 5000) => new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; resolve(false); }, timeoutMs);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
  if (steamCdnAllBtn) steamCdnAllBtn.addEventListener('click', async () => {
    _closeActions();
    if (!state.rows.length) return;
    const steamRows = state.rows.filter((r) => r.type === 'steam');
    const total = steamRows.length;
    if (!total) return;
    if (!confirm(`Probe the Steam CDN wide-aspect variants for ${total.toLocaleString()} Steam row${total === 1 ? '' : 's'} and set the first one that loads as the override?\n\nOrder: header, capsule_616x353, capsule_467x181, capsule_231x87, library_hero. Non-Steam rows and rows that already have an admin override are skipped.`)) return;
    setBatchRunning(true);
    cancelToken = { cancelled: false };
    let done = 0, ok = 0, skip = 0, fail = 0;
    try {
      progEl.textContent = `Steam CDN wide: 0 / ${total}...`;
      for (const r of steamRows) {
        if (cancelToken.cancelled) break;
        done += 1;
        if (r.override?.image_url) { skip += 1; }
        else {
          // #348: try the Fastly-fronted store_item_assets mirror before
          // the legacy Cloudflare CDN. Some games 404 on Cloudflare but
          // 200 on Fastly. Order: cloudflare (widest historical coverage)
          // then fastly (newer mirror).
          const bases = [
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(r.appId)}`,
            `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(r.appId)}`,
          ];
          // Try each wide variant in preference order across every base;
          // stop at the first hit.
          let picked = null;
          outer: for (const file of STEAM_CDN_WIDE_PREF) {
            for (const base of bases) {
              if (cancelToken.cancelled) break outer;
              const url = `${base}/${file}`;
              if (await _imgLoads(url)) { picked = url; break outer; }
            }
          }
          if (picked) {
            const applied = await setBoxArtOverride(r.appId, picked);
            if (applied.ok) {
              r.override = { image_url: picked, source: 'manual' };
              if (indexes.overrideMap) indexes.overrideMap[r.appId] = r.override;
              ok += 1;
            } else { fail += 1; }
          } else { fail += 1; }
          // Modest breather between rows so the browser stays responsive
          // on very large filter sets (thousands of Steam rows).
          await new Promise((res) => setTimeout(res, 50));
        }
        progEl.textContent = `Steam CDN wide: ${done} / ${total} \u00b7 ${ok} set / ${skip} skipped / ${fail} failed`;
      }
      progEl.textContent = `Done: ${done} scanned \u00b7 ${ok} set / ${skip} skipped / ${fail} failed${cancelToken.cancelled ? ' (cancelled)' : ''}`;
    } finally {
      setBatchRunning(false);
      progEl.hidden = false;
      _renderPage(state.rows, state.page);
    }
  });

  cancelBtn.addEventListener('click', () => {
    _closeActions();
    cancelToken.cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling...';
    setTimeout(() => { cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel'; }, 1500);
  });

  // Modal + upload input handles for admin override actions.
  const modal      = document.getElementById('boxart-modal-backdrop');
  const modalInput = document.getElementById('boxart-modal-input');
  const modalErr   = document.getElementById('boxart-modal-error');
  const uploadInp  = document.getElementById('boxart-upload-input');
  let   modalContext = null;   // { tr, appId }

  function _openSetUrlModal(tr) {
    modalContext = { tr, appId: tr.dataset.appid };
    modalInput.value = tr.dataset.cached || '';
    modalErr.hidden = true; modalErr.textContent = '';
    modal.hidden = false; modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => modalInput.focus(), 0);
  }
  function _closeModal() {
    modal.hidden = true; modal.setAttribute('aria-hidden', 'true');
    modalContext = null;
  }
  modal.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-modal-action]');
    if (!btn) return;
    if (btn.dataset.modalAction === 'cancel') return _closeModal();
    if (btn.dataset.modalAction === 'save' && modalContext) {
      const url = modalInput.value.trim();
      btn.disabled = true;
      modalErr.hidden = true;
      const result = await setBoxArtOverride(modalContext.appId, url);
      btn.disabled = false;
      if (!result.ok) {
        modalErr.hidden = false;
        modalErr.textContent = result.error || 'save failed';
        return;
      }
      _applyOverrideToRow(modalContext.tr, modalContext.appId, { image_url: result.url, source: 'manual' });
      _closeModal();
    }
  });
  // Upload input fires 'change' when a file is picked. modalContext is
  // repurposed to remember which row triggered the picker.
  uploadInp.addEventListener('change', async () => {
    const file = uploadInp.files?.[0];
    if (!file || !modalContext) { uploadInp.value = ''; return; }
    const { tr, appId } = modalContext;
    const statusEl = tr.querySelector('.boxart-status');
    statusEl.innerHTML = '<span class="admin-muted">uploading...</span>';
    const result = await uploadBoxArtOverride(appId, file);
    uploadInp.value = ''; // allow re-picking the same file later
    if (!result.ok) {
      _paintStatus(statusEl, result);
      return;
    }
    _applyOverrideToRow(tr, appId, { image_url: result.url, source: 'upload' });
  });

  // After a set/upload succeeds we mutate the row locally so the admin
  // sees Admin override without reloading. Also updates the in-memory
  // overrideMap so refilter() keeps this row visible if the status
  // filter is set to "override".
  function _applyOverrideToRow(tr, appId, override) {
    if (!indexes.overrideMap) indexes.overrideMap = {};
    indexes.overrideMap[appId] = { app_id: appId, ...override };
    const r = state.rows.find(x => x.appId === appId);
    if (r) { r.override = indexes.overrideMap[appId]; r.derivedStatus = 'override'; }
    const statusEl = tr.querySelector('.boxart-status');
    if (statusEl) statusEl.innerHTML = `<span class="admin-badge admin-badge--ok" title="Admin override (${escapeHtml(override.source)}) -- pipeline preserves this on every run">Admin override</span> <a href="${escapeHtml(override.image_url)}" target="_blank" rel="noopener" class="admin-link">view</a>`;
    const clearBtn = tr.querySelector('button[data-action="clear"]');
    if (clearBtn) clearBtn.hidden = false;
  }
  function _removeOverrideFromRow(tr, appId) {
    if (indexes.overrideMap) delete indexes.overrideMap[appId];
    const r = state.rows.find(x => x.appId === appId);
    if (r) { r.override = null; r.derivedStatus = _deriveStatus(r.type, r.appId, r.cachedUrl, false, indexes.knownMissingSteam, indexes.knownMissingNonSteam); }
    const statusEl = tr.querySelector('.boxart-status');
    if (statusEl && r) statusEl.innerHTML = _initialStatusHtml(r);
    const clearBtn = tr.querySelector('button[data-action="clear"]');
    if (clearBtn) clearBtn.hidden = true;
  }

  table.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const appId = tr.dataset.appid;
    btn.disabled = true;
    try {
      const action = btn.dataset.action;
      if (action === 'probe') await _probeRow(tr, indexes.gameImages);
      else if (action === 'refetch') await _refetchRow(tr);
      else if (action === 'sgdb') await _sgdbRow(tr);
      else if (action === 'set-url') _openSetUrlModal(tr);
      else if (action === 'upload') {
        modalContext = { tr, appId };
        uploadInp.click();
      }
      else if (action === 'clear') {
        if (!confirm(`Remove the admin override for ${appId}? This can't be undone.`)) return;
        const result = await clearBoxArtOverride(appId);
        if (result.ok) _removeOverrideFromRow(tr, appId);
        else _paintStatus(tr.querySelector('.boxart-status'), result);
      }
    } finally {
      btn.disabled = false;
    }
  });

  pager.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-page-action]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.pageAction === 'prev' && state.page > 0) state.page -= 1;
    else if (btn.dataset.pageAction === 'next') state.page += 1;
    _renderPage(state.rows, state.page);
    // Restore previously-probed status cells on the newly-shown page.
    if (state.rows.some(r => r._probe)) {
      const tbody = document.getElementById('boxart-tbody');
      Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
        const r = state.rows.find(x => x.appId === tr.dataset.appid);
        if (r && r._probe) _paintStatus(tr.querySelector('.boxart-status'), r._probe);
      });
    }
  });

  refilter();
}


// --- Detail view -----------------------------------------------------
//
// Full-page view for one app. Shows every URL source (default CDN,
// cloudflare CDN, pipeline fallback from game-images.json, admin
// override) with the current live URL called out, a preview image,
// override metadata, and all action buttons at the top.

const _DETAIL_ACTIONS = [
  { action: 'probe',   label: 'Probe',   cls: '',                     title: 'HEAD the canonical URL' },
  { action: 'refetch', label: 'Refetch', cls: '',                     title: "Ask the store's API for the current header URL" },
  { action: 'sgdb',    label: 'SGDB (by app id)', cls: '',            title: 'Fetch from SteamGridDB via Steam appid lookup. Errors if SGDB has no match for this appid; use the section below to search by title instead.' },
  { action: 'sgdb-first', label: 'Set first SGDB result', cls: 'admin-btn--primary', title: 'Search SteamGridDB by the cleaned title and apply the first widescreen grid as the override in one click.' },
  { action: 'set-url', label: 'Set URL', cls: 'admin-btn--primary',   title: 'Set a custom URL that survives pipeline reruns' },
  { action: 'upload',  label: 'Upload',  cls: 'admin-btn--primary',   title: 'Upload an image (PNG/JPG/WebP, <= 2 MB)' },
  { action: 'clear',   label: 'Clear override', cls: 'admin-btn--danger', title: 'Remove the admin override', overrideOnly: true },
];

function _detailShell() {
  return `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px">
      <a class="admin-btn" href="admin.html?tab=boxart" title="Back to the Box Art Manager list">&larr; Back to list</a>
      <h2 id="boxart-detail-title" class="admin-section-title" style="margin:0; flex:1"></h2>
    </div>
    <div id="boxart-detail-body"><div class="admin-loading">Loading...</div></div>
    <div id="boxart-sgdb-panel"></div>
    <div id="boxart-steam-cdn-panel"></div>
  `;
}

// Standard Steam CDN image variants per app. Each has a stable URL under
// /steam/apps/<appid>/<file>. Ordered biggest-first so the visually useful
// variants (library, hero, capsule) surface above the small marketing crops.
const STEAM_CDN_VARIANTS = [
  { file: 'library_600x900.jpg',    label: 'Library capsule (600x900)',  aspect: '600 / 900' },
  { file: 'library_600x900_2x.jpg', label: 'Library capsule retina',     aspect: '600 / 900' },
  { file: 'library_hero.jpg',       label: 'Library hero (1920x620)',    aspect: '1920 / 620' },
  { file: 'header.jpg',             label: 'Header (460x215)',           aspect: '460 / 215' },
  { file: 'capsule_616x353.jpg',    label: 'Capsule (616x353)',          aspect: '616 / 353' },
  { file: 'capsule_467x181.jpg',    label: 'Capsule (467x181)',          aspect: '467 / 181' },
  { file: 'capsule_231x87.jpg',     label: 'Capsule (231x87)',           aspect: '231 / 87' },
  { file: 'logo.png',               label: 'Logo (transparent)',         aspect: 'auto' },
  { file: 'page_bg_raw.jpg',        label: 'Page background (raw)',      aspect: '1438 / 810' },
];

// Steam CDN image panel shell: on-demand, mirrors the SGDB search UX.
// The admin clicks Fetch; the click handler probes every variant, then
// renders only the ones that returned ok. Empty until requested so the
// panel does not eat 9 image-load requests per detail-page open.
function _steamCdnPanelHtml(row) {
  if (row.type !== 'steam') return '';
  return `
    <div class="admin-card" style="padding:14px 16px; margin-top:16px">
      <div class="admin-subhead">Steam CDN images</div>
      <p class="admin-hint" style="margin:6px 0 10px">On-demand fetch of every image Steam hosts for this app. Click Fetch to probe each variant; only ones that return 200 render below.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button class="admin-btn admin-btn--primary" data-steamcdn="fetch">Fetch Steam CDN images</button>
      </div>
      <p id="steamcdn-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
      <div id="steamcdn-results" class="sgdb-results"></div>
    </div>`;
}

// Render one Steam CDN result card. Matches the SGDB card layout so the
// two panels sit visually flush and the Set-as-override button uses the
// same class the SGDB handler already listens on.
function _steamCdnCardHtml(variant, url) {
  return `
    <div class="sgdb-card steam-cdn-card">
      <a class="sgdb-thumb-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open the full-size image in a new tab">
        <img class="sgdb-thumb steam-cdn-thumb" src="${escapeHtml(url)}" alt="Steam ${escapeHtml(variant.label)}" loading="lazy"
             style="aspect-ratio:${variant.aspect}; object-fit:contain; background:rgba(255,255,255,0.03)"
             onerror="this.closest('.steam-cdn-card').style.display='none'">
      </a>
      <div class="sgdb-meta">${escapeHtml(variant.label)}</div>
      <button class="admin-btn admin-btn--primary sgdb-set" data-steamcdn-set="${escapeHtml(url)}">Set as box art</button>
    </div>`;
}

// SteamGridDB search panel: an editable term (defaulted to the trademark-
// stripped title) + a results grid the admin picks from. Lives outside
// #boxart-detail-body so a body refresh does not wipe the search results.
function _sgdbPanelHtml(row) {
  const term = _cleanTitle(row.title);
  const byIdBtn = row.type === 'steam'
    ? `<button class="admin-btn" data-sgdb="search-id" title="Search by Steam app id instead of the title">By Steam id</button>`
    : '';
  // External link to the SteamGridDB website for manual inspection (opens the
  // same search in the browser). Uses the raw title -- the site handles the
  // trademark symbol in its own search.
  const webHref = `https://www.steamgriddb.com/search/grids?term=${encodeURIComponent(row.title || row.appId)}`;
  return `
    <div class="admin-card" style="padding:14px 16px; margin-top:16px">
      <div class="admin-subhead">SteamGridDB artwork</div>
      <p class="admin-hint" style="margin:6px 0 10px">Search community artwork and set one as the box art override. The term defaults to the title with trademark symbols stripped; edit it to broaden or fix the search.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <input id="sgdb-term" class="admin-input" type="text" value="${escapeHtml(term)}" placeholder="Search SteamGridDB by title" style="flex:0 1 300px; min-width:0">
        <select id="sgdb-dims" class="admin-select" title="Filter results by grid dimensions. Box art is a 460x215 header, so Widescreen is the right shape.">
          <option value="460x215,920x430" selected>Widescreen (460x215, 920x430)</option>
          <option value="600x900">Vertical (600x900)</option>
          <option value="342x482,660x930">Galaxy (342x482, 660x930)</option>
          <option value="512x512,1024x1024">Square (512x512, 1024x1024)</option>
          <option value="">Any dimensions</option>
        </select>
        <button class="admin-btn admin-btn--primary" data-sgdb="search">Search</button>
        ${byIdBtn}
        <a class="admin-btn" href="${escapeHtml(webHref)}" target="_blank" rel="noopener" title="Open this search on the SteamGridDB website for manual inspection">Open on SteamGridDB</a>
      </div>
      <p id="sgdb-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
      <div id="sgdb-results" class="sgdb-results"></div>
    </div>`;
}

// Render the results grid (or an error / empty note) from a searchSgdb payload.
function _sgdbResultsHtml(payload) {
  if (!payload || !payload.ok) {
    return `<p class="admin-error" style="margin:12px 0 0">${escapeHtml(payload?.error || 'search failed')}</p>`;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) return `<p class="admin-hint" style="margin:12px 0 0">No grids found.</p>`;
  const name = payload.game?.name ? ` for <strong>${escapeHtml(payload.game.name)}</strong>` : '';
  const head = `<p class="admin-hint" style="margin:12px 0 8px">${results.length} grid${results.length !== 1 ? 's' : ''}${name} -- click Set to use one as the box art.</p>`;
  const cards = results.map((g) => {
    const dims = `${g.width || '?'}x${g.height || '?'}${g.style ? ' · ' + escapeHtml(g.style) : ''}`;
    return `
      <div class="sgdb-card">
        <a class="sgdb-thumb-link" href="${escapeHtml(g.url)}" target="_blank" rel="noopener" title="Open the full-size image in a new tab">
          <img class="sgdb-thumb" src="${escapeHtml(g.thumb || g.url)}" alt="SteamGridDB grid ${escapeHtml(String(g.id || ''))}" loading="lazy" onerror="this.style.opacity=0.25">
        </a>
        <div class="sgdb-meta">${dims}</div>
        <button class="admin-btn admin-btn--primary sgdb-set" data-sgdb-set="${escapeHtml(g.url)}">Set as box art</button>
      </div>`;
  }).join('');
  return head + `<div class="sgdb-grid">${cards}</div>`;
}

function _detailActionsHtml(hasOverride) {
  return _DETAIL_ACTIONS
    .filter(a => !a.overrideOnly || hasOverride)
    .map(a => `<button class="admin-btn ${a.cls}" data-action="${a.action}" title="${escapeHtml(a.title)}">${escapeHtml(a.label)}</button>`)
    .join(' ');
}

function _urlRowHtml(label, url, opts = {}) {
  const { note = '', highlight = false, plain = false } = opts;
  // `plain` rows carry an identifier (App ID, store name), not a URL. Rendering
  // those through the <a href> branch produced a broken relative link (e.g.
  // href="2807960") that navigated nowhere instead of to the store.
  const val = url
    ? (plain
        ? escapeHtml(String(url))
        : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="admin-link" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`)
    : '<span class="admin-muted">(none)</span>';
  const noteHtml = note ? `<span class="admin-muted" style="margin-left:8px">${escapeHtml(note)}</span>` : '';
  const rowStyle = highlight ? 'background: rgba(80, 200, 120, 0.08);' : '';
  return `
    <tr style="${rowStyle}">
      <th style="text-align:left; padding:8px 12px; white-space:nowrap; vertical-align:top">${escapeHtml(label)}</th>
      <td style="padding:8px 12px; word-break:break-all">${val}${noteHtml}</td>
    </tr>`;
}

function _detailBodyHtml(row, currentLiveUrl, currentSource) {
  const { appId, type, title, cachedUrl, override } = row;
  const storeHref = _storeHref(type, appId, title);
  const storeLink = storeHref
    ? `<a href="${escapeHtml(storeHref)}" target="_blank" rel="noopener" class="admin-link">Open on ${escapeHtml(type)} store</a>`
    : `<span class="admin-muted">no store link</span>`;
  const gamePageLink = `<a href="${_appHref(appId)}" target="_blank" rel="noopener" class="admin-link">Open game page</a>`;
  // Link to the Game Manager admin tab so a moderator triaging box art
  // can jump straight into hide / remap actions for this app. Game
  // Manager does not deep-link to an app id yet -- it opens the tab
  // with the form pre-populated via the appid= param.
  const gameManagerLink = `<a href="admin.html?tab=games&amp;appid=${encodeURIComponent(appId)}" class="admin-link">Open in Game Manager</a>`;

  // Standard Steam URLs (only meaningful for type=steam).
  const akamaiUrl     = type === 'steam' ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appId)}/header.jpg` : null;
  // #348: Steam's newer Fastly-fronted mirror. Same store_item_assets path
  // Akamai serves but on a different CDN. Some games 404 on Akamai but 200
  // on Fastly (or vice-versa), so surfacing it here lets admins verify.
  const fastlyUrl     = type === 'steam' ? `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appId)}/header.jpg` : null;
  const cloudflareUrl = type === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(appId)}/header.jpg` : null;

  const previewSrc = currentLiveUrl || override?.image_url || cachedUrl || akamaiUrl || '';

  const overrideMeta = override
    ? `<span class="admin-badge admin-badge--ok" title="Preserved on every pipeline run">Admin override</span>
       <span class="admin-muted">source: ${escapeHtml(override.source || 'manual')}</span>
       ${override.updated_at ? `<span class="admin-muted">updated: ${escapeHtml(String(override.updated_at).slice(0, 19).replace('T', ' '))}</span>` : ''}`
    : '<span class="admin-muted">no override set</span>';

  return `
    <div class="admin-card" style="padding:14px 16px; margin-bottom:16px">
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center">${_detailActionsHtml(!!override)}</div>
      <p id="boxart-detail-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
    </div>

    <div class="boxart-detail-grid">
      <div class="admin-card" style="padding:12px">
        <div class="admin-subhead">Preview</div>
        <img id="boxart-detail-preview" src="${escapeHtml(previewSrc)}" alt="header preview" data-appid="${escapeHtml(appId)}" data-type="${escapeHtml(type)}" data-auto-refetch-tried="0" style="width:100%; height:auto; display:block; border-radius:6px; background: rgba(255,255,255,0.05)">
        <p class="admin-hint" style="margin:8px 0 0">${gamePageLink} &middot; ${storeLink} &middot; ${gameManagerLink}</p>
      </div>

      <div class="admin-card" style="padding:0; overflow:hidden">
        <table class="admin-table" style="width:100%; margin:0">
          <thead>
            <tr><th colspan="2" style="text-align:left; padding:10px 12px">URL sources <span class="admin-muted" style="font-weight:normal">(highlighted row = live source)</span></th></tr>
          </thead>
          <tbody>
            ${_urlRowHtml('App ID', appId, { plain: true })}
            ${_urlRowHtml('Store', type, { plain: true })}
            ${_urlRowHtml('Admin override', override?.image_url || null, { highlight: currentSource === 'override', note: currentSource === 'override' ? 'live' : '' })}
            ${type === 'steam' ? _urlRowHtml('Default CDN (akamai)', akamaiUrl, { highlight: currentSource === 'akamai',     note: currentSource === 'akamai'     ? 'live' : '' }) : ''}
            ${type === 'steam' ? _urlRowHtml('Fastly CDN',           fastlyUrl,     { highlight: currentSource === 'fastly',     note: currentSource === 'fastly'     ? 'live' : '' }) : ''}
            ${type === 'steam' ? _urlRowHtml('Cloudflare CDN',       cloudflareUrl, { highlight: currentSource === 'cloudflare', note: currentSource === 'cloudflare' ? 'live' : '' }) : ''}
            ${_urlRowHtml(type === 'steam' ? 'Pipeline fallback (game-images.json)' : 'Pipeline URL (nonsteam-images.json)', cachedUrl, { highlight: currentSource === 'pipeline', note: currentSource === 'pipeline' ? 'live' : '' })}
            <tr aria-hidden="true"><td colspan="2" style="height:14px; border:none; padding:0"></td></tr>
            ${_urlRowHtml('Override metadata', null)}
            <tr><td colspan="2" style="padding:6px 12px 12px">${overrideMeta}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// Given the URL sources for this row, resolve which one the frontend
// would actually display. Overrides always win. Otherwise HEAD-probe
// in the standard fallback order.
// Auto-refetch on preview img error. Called once per detail render; the
// handler self-guards against a refetch loop via data-auto-refetch-tried.
// Uses the server-side refetch path (Steam appdetails / non-Steam pipeline
// probe) which resolves hashed URLs the plain-URL prober cannot see. On
// success, swaps the preview src AND updates the URL-sources table (via
// refreshBody in the caller) so the "live source" highlight is honest.
function _wireAutoRefetch(row) {
  const img = document.getElementById('boxart-detail-preview');
  if (!img) return;
  img.addEventListener('error', async () => {
    if (img.dataset.autoRefetchTried === '1') {
      img.style.opacity = 0.3;
      img.alt = '(preview failed to load)';
      return;
    }
    img.dataset.autoRefetchTried = '1';
    img.alt = 'header preview (auto-refetching...)';
    const result = row.type === 'steam'
      ? await refetchSteamHeader(row.appId)
      : await refetchNonSteamHeader(row.appId, row.cachedUrl || null);
    if (result?.ok && result.url) {
      img.src = result.url;
      img.style.opacity = 1;
      img.alt = 'header preview';
    } else {
      img.style.opacity = 0.3;
      img.alt = '(preview failed to load; refetch also failed)';
    }
  }, { once: false });
}

async function _resolveCurrentLive(row) {
  if (row.override?.image_url) return { url: row.override.image_url, source: 'override' };
  if (row.type === 'steam') {
    const akamai = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(row.appId)}/header.jpg`;
    // #348: Steam started rolling out a Fastly-fronted mirror at
    // shared.fastly.steamstatic.com/store_item_assets/steam/apps/<id>/header.jpg
    // which returns 200 for some games where the Akamai / Cloudflare paths
    // 404 without the content-hash segment. Probe it before falling back to
    // the pipeline cache.
    const fastly = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(row.appId)}/header.jpg`;
    const cloudflare = `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(row.appId)}/header.jpg`;
    let r = await probeImageUrl(akamai);
    if (r.ok) return { url: akamai, source: 'akamai' };
    r = await probeImageUrl(fastly);
    if (r.ok) return { url: fastly, source: 'fastly' };
    r = await probeImageUrl(cloudflare);
    if (r.ok) return { url: cloudflare, source: 'cloudflare' };
    if (row.cachedUrl) {
      r = await probeImageUrl(row.cachedUrl);
      if (r.ok) return { url: row.cachedUrl, source: 'pipeline' };
    }
    return { url: null, source: null };
  }
  // GOG / Epic: only the pipeline URL exists as a candidate.
  if (row.cachedUrl) {
    const r = await probeImageUrl(row.cachedUrl);
    if (r.ok) return { url: row.cachedUrl, source: 'pipeline' };
  }
  return { url: null, source: null };
}

export async function renderBoxartAdminDetail(appId) {
  const content = document.getElementById('boxart-detail-content');
  if (!content) return;
  content.innerHTML = _detailShell();

  let indexes;
  try {
    // Force a fresh fetch so admin edits made in another tab reflect here.
    _cache = null;
    indexes = await _loadIndexes();
  } catch (e) {
    content.innerHTML = `<p class="admin-error">Failed to load indexes: ${escapeHtml(e.message || String(e))}</p>`;
    return;
  }

  // Locate the row for this appId. Check the main index first, then the extended
  // Steam catalog (#363) so a long-tail title like Cat Chess (4163030) opens its
  // detail view instead of the not-found error below.
  const searchRow =
    (indexes.searchIndex || []).find(r => Array.isArray(r) && String(r[0]) === String(appId)) ||
    (indexes.extendedIndex || []).find(r => Array.isArray(r) && String(r[0]) === String(appId));
  if (!searchRow) {
    content.innerHTML = `<p class="admin-error">App id <code>${escapeHtml(appId)}</code> not found in the search index.</p>`;
    return;
  }
  const type = searchRow[5] || (String(appId).startsWith('gog:') ? 'gog' : String(appId).startsWith('epic:') ? 'epic' : 'steam');
  const cachedUrl = type === 'steam' ? (indexes.gameImages[appId] || null) : (indexes.nonSteam[appId] || null);
  const override = indexes.overrideMap?.[appId] || null;
  const row = { appId: String(appId), title: String(searchRow[1] || ''), type, cachedUrl, override, derivedStatus: _deriveStatus(type, String(appId), cachedUrl, !!override, indexes.knownMissingSteam, indexes.knownMissingNonSteam) };

  // Header carries the store label + app id so admins can copy the id or eyeball
  // which storefront they're editing without scrolling to the meta rows. (#199)
  document.getElementById('boxart-detail-title').textContent = `Box Art: ${row.title || row.appId} - ${row.type} - App ${row.appId}`;

  // Initial paint uses cached URL as preview; then swap once _resolveCurrentLive returns.
  document.getElementById('boxart-detail-body').innerHTML = _detailBodyHtml(row, null, null);
  const live = await _resolveCurrentLive(row).catch(() => ({ url: null, source: null }));
  document.getElementById('boxart-detail-body').innerHTML = _detailBodyHtml(row, live.url, live.source);
  // Auto-refetch on preview load failure. `_resolveCurrentLive` only probes
  // plain CDN URLs; games whose header ships under a Steam content hash
  // (e.g. .../<appid>/<hash>/header.jpg) 404 on the plain path and the
  // preview img fires onerror. Same click that clicking Refetch would do,
  // done automatically so the admin sees the correct art immediately.
  _wireAutoRefetch(row);

  // Wire the shared modal + upload input for this view. modalContext
  // is set BEFORE opening the modal or triggering the file picker so
  // the change/save handlers know which appId is in scope.
  const modal      = document.getElementById('boxart-modal-backdrop');
  const modalInput = document.getElementById('boxart-modal-input');
  const modalErr   = document.getElementById('boxart-modal-error');
  const uploadInp  = document.getElementById('boxart-upload-input');
  let ctx = null;    // { appId }

  function refreshBody() {
    _resolveCurrentLive(row).catch(() => ({ url: null, source: null })).then(l => {
      document.getElementById('boxart-detail-body').innerHTML = _detailBodyHtml(row, l.url, l.source);
      // Re-wire the auto-refetch since the innerHTML swap replaced the img
      // element that was carrying the previous listener.
      _wireAutoRefetch(row);
    });
  }
  function setStatus(text, isError) {
    const el = document.getElementById('boxart-detail-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.className = 'admin-hint';
    // pre-line so the multi-line diagnostic from _formatBoxartResult keeps
    // its structure without needing innerHTML/br injection. (#199)
    el.style.whiteSpace = 'pre-line';
    if (isError) el.classList.add('admin-error');
  }
  // Format a refetch/probe result into a multi-line diagnostic block so
  // admins see exactly which URL was hit, the status, and any Steam
  // redirect target (e.g. old appid 5488 -> new appid 45700). (#199)
  function _formatBoxartResult(action, result) {
    if (result.ok) {
      return `${action} ok\nsource: ${result.source || 'unknown'}\nresolved via: ${result.resolved_via || 'unknown'}\nurl: ${result.url}`;
    }
    const lines = [`${action} failed`];
    if (result.source) lines.push(`source: ${result.source}`);
    if (result.status != null) lines.push(`status: ${result.status}`);
    lines.push(`error: ${result.error || 'unknown'}`);
    if (result.attempted_url) lines.push(`attempted url: ${result.attempted_url}`);
    if (result.final_url) lines.push(`store redirected to: ${result.final_url}`);
    if (result.upstream_snippet) lines.push(`upstream body: ${result.upstream_snippet}`);
    return lines.join('\n');
  }

  // SteamGridDB search-and-pick panel. Persistent (outside the refreshed
  // body) so results survive a preview refresh. Search returns a grid of
  // candidates; "Set as box art" writes the override via set_override.
  const sgdbPanel = document.getElementById('boxart-sgdb-panel');
  if (sgdbPanel) {
    sgdbPanel.innerHTML = _sgdbPanelHtml(row);
    const sgdbStatus = (text, isError) => {
      const e = document.getElementById('sgdb-status');
      if (!e) return;
      e.hidden = false;
      e.textContent = text;
      e.className = 'admin-hint' + (isError ? ' admin-error' : '');
    };
    sgdbPanel.addEventListener('click', async (ev) => {
      const searchBtn = ev.target.closest('[data-sgdb]');
      const setBtn = ev.target.closest('[data-sgdb-set]');
      if (searchBtn) {
        const byId = searchBtn.dataset.sgdb === 'search-id';
        const term = byId ? '' : (document.getElementById('sgdb-term')?.value || '').trim();
        const dims = document.getElementById('sgdb-dims')?.value || '';
        sgdbStatus('Searching SteamGridDB...');
        searchBtn.disabled = true;
        const payload = await searchSgdb(row.appId, term, dims);
        searchBtn.disabled = false;
        const resultsEl = document.getElementById('sgdb-results');
        if (resultsEl) resultsEl.innerHTML = _sgdbResultsHtml(payload);
        // On failure the results panel already shows the SteamGridDB
        // error verbatim; the status line was duplicating it. Keep the
        // status short for successes and hide it on failure so there's
        // only one error message visible.
        if (payload.ok) {
          sgdbStatus(`${(payload.results || []).length} result(s)`);
        } else {
          const statusEl = document.getElementById('sgdb-status');
          if (statusEl) statusEl.hidden = true;
        }
        return;
      }
      if (setBtn) {
        const url = setBtn.dataset.sgdbSet;
        if (!url) return;
        setBtn.disabled = true;
        sgdbStatus('Setting box art override...');
        const res = await setBoxArtOverride(row.appId, url);
        setBtn.disabled = false;
        if (res.ok) {
          row.override = { image_url: url, source: 'manual' };
          if (indexes.overrideMap) indexes.overrideMap[row.appId] = row.override;
          sgdbStatus('Box art override set from SteamGridDB.');
          setStatus('override set from SteamGridDB: ' + url);
          refreshBody();
          const prev = document.getElementById('boxart-detail-preview');
          if (prev) { prev.src = url; prev.style.opacity = 1; }
        } else {
          sgdbStatus('Set failed: ' + (res.error || 'unknown'), true);
        }
        return;
      }
    });
    document.getElementById('sgdb-term')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sgdbPanel.querySelector('[data-sgdb="search"]')?.click(); }
    });
  }

  // Steam CDN image panel (#345). On-demand fetch: Fetch button probes
  // every variant, then renders only the ones that returned ok. Set-as-
  // override reuses the SGDB setBoxArtOverride path so the plumbing after
  // "set" is identical.
  const steamCdnPanel = document.getElementById('boxart-steam-cdn-panel');
  if (steamCdnPanel) {
    steamCdnPanel.innerHTML = _steamCdnPanelHtml(row);
    const steamCdnStatus = (text, isError) => {
      const el = document.getElementById('steamcdn-status');
      if (!el) return;
      el.hidden = false;
      el.textContent = text;
      el.className = 'admin-hint' + (isError ? ' admin-error' : '');
    };
    steamCdnPanel.addEventListener('click', async (ev) => {
      const fetchBtn = ev.target.closest('[data-steamcdn="fetch"]');
      const setBtn = ev.target.closest('[data-steamcdn-set]');
      if (fetchBtn) {
        if (row.type !== 'steam') {
          steamCdnStatus('Steam CDN images are only available for Steam apps.', true);
          return;
        }
        fetchBtn.disabled = true;
        steamCdnStatus('Loading Steam CDN variants...');
        // #348: Try Cloudflare first (broadest historical coverage) then
        // Fastly (newer store_item_assets mirror). Some games only serve
        // via one of the two -- surfacing both catches everything.
        const bases = [
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(row.appId)}`,
          `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(row.appId)}`,
        ];
        // Use <img> load detection instead of fetch(). Steam CDN sends CORS
        // headers on files it serves, but browser fetch() still fails on
        // many of them (some variants get redirected through hashed URLs,
        // some 403 the OPTIONS pre-check). The <img> element ignores CORS
        // for pure display, so onload/onerror is the reliable existence
        // signal. Same trick SteamDB + OMGDuke's protondb-decky use.
        const results = await Promise.all(STEAM_CDN_VARIANTS.flatMap((v) => bases.map((base) => new Promise((resolve) => {
          const url = `${base}/${v.file}`;
          const img = new Image();
          img.onload = () => resolve({ v, url });
          img.onerror = () => resolve(null);
          img.src = url;
        }))));
        // Dedupe by variant.file so a game that loads on both Cloudflare
        // and Fastly renders as one card (preferring the first hit, which
        // per the bases order is Cloudflare).
        const seen = new Set();
        const hits = [];
        for (const r of results) {
          if (!r || seen.has(r.v.file)) continue;
          seen.add(r.v.file);
          hits.push(r);
        }
        const resultsEl = document.getElementById('steamcdn-results');
        if (resultsEl) {
          resultsEl.innerHTML = hits.length
            ? `<div class="sgdb-grid">${hits.map(({v, url}) => _steamCdnCardHtml(v, url)).join('')}</div>`
            : `<p class="admin-hint" style="margin:12px 0 0">No Steam CDN variants loaded for app id ${escapeHtml(row.appId)}. The images might not exist for this app, or the CDN did not serve them at request time -- try again in a moment.</p>`;
        }
        steamCdnStatus(`Steam CDN: ${hits.length} of ${STEAM_CDN_VARIANTS.length} variants available.`);
        fetchBtn.disabled = false;
        return;
      }
      if (setBtn) {
        const url = setBtn.dataset.steamcdnSet;
        if (!url) return;
        setBtn.disabled = true;
        steamCdnStatus('Setting box art override from Steam CDN...');
        const res = await setBoxArtOverride(row.appId, url);
        setBtn.disabled = false;
        if (res.ok) {
          row.override = { image_url: url, source: 'manual' };
          if (indexes.overrideMap) indexes.overrideMap[row.appId] = row.override;
          steamCdnStatus('Box art override set from Steam CDN.');
          setStatus('override set from Steam CDN: ' + url);
          refreshBody();
          const prev = document.getElementById('boxart-detail-preview');
          if (prev) { prev.src = url; prev.style.opacity = 1; }
        } else {
          steamCdnStatus('Set failed: ' + (res.error || 'unknown'), true);
        }
      }
    });
  }

  content.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    btn.disabled = true;
    try {
      if (action === 'probe' || action === 'refetch' || action === 'sgdb') {
        setStatus(`${action}ing...`);
        let result;
        if (action === 'probe') {
          result = row.type === 'steam'
            ? await probeSteamHeader(row.appId, row.cachedUrl || null)
            : await refetchNonSteamHeader(row.appId, row.cachedUrl || null);
        } else if (action === 'refetch') {
          result = row.type === 'steam'
            ? await refetchSteamHeader(row.appId)
            : await refetchNonSteamHeader(row.appId, row.cachedUrl || null);
          // #351: refetch's returned URL is only guaranteed to be HEAD-200
          // server-side. The browser's <img> element occasionally sees a
          // different result (redirect chain 404, region-locked CDN edge,
          // CORS shadowing on the actual GET). When the returned URL will
          // not render in-browser, walk the Akamai / Fastly / Cloudflare
          // fallback ladder and surface the first one that does load. If
          // any candidate wins, update the preview <img> so the admin
          // sees the working image immediately.
          if (result?.ok && result.url && row.type === 'steam') {
            const originalUrl = result.url;
            if (!(await _imgLoadsBrowser(originalUrl))) {
              let winner = null;
              for (const candidate of _steamRefetchFallbacks(originalUrl, row.appId)) {
                if (await _imgLoadsBrowser(candidate)) { winner = candidate; break; }
              }
              if (winner) {
                result = { ...result, url: winner, resolved_via: `${result.resolved_via || 'appdetails'} (browser fallback)` };
              } else {
                result = { ok: false, url: originalUrl, error: 'refetch returned a URL but no candidate loaded in browser (tried Akamai, Fastly, Cloudflare)' };
              }
            }
          }
          if (result?.ok && result.url) {
            const prev = document.getElementById('boxart-detail-preview');
            if (prev) { prev.src = result.url; prev.style.opacity = 1; prev.alt = 'header preview'; }
          }
        } else {
          result = await refetchSgdbHeader(row.appId);
          // Common failure: SGDB has no entry for this Steam appid.
          // The bottom-of-page title search still works so hint at it.
          if (!result?.ok && /no match|no game id|non-Steam id/i.test(result?.error || '')) {
            result = {
              ...result,
              error: `${result.error} -- try the "Set first SGDB result" button (searches by title) or the SteamGridDB panel below.`,
            };
          }
        }
        setStatus(_formatBoxartResult(action, result), !result.ok);
      } else if (action === 'sgdb-first') {
        // Search SteamGridDB by cleaned title, apply the first widescreen
        // grid as the override, no manual click needed. Falls back to any
        // dimension if widescreen returns zero. Same happy-path shape as
        // the manual per-tile "Set as box art" button.
        setStatus('sgdb-first: searching by title...');
        const term = _cleanTitle(row.title);
        let sr = await searchSgdb(row.appId, term, '460x215,920x430');
        if (!sr?.ok || !Array.isArray(sr.results) || sr.results.length === 0) {
          setStatus('sgdb-first: no widescreen results; retrying without dim filter...');
          sr = await searchSgdb(row.appId, term, '');
        }
        if (!sr?.ok) {
          setStatus(`sgdb-first failed: ${sr?.error || 'search error'}`, true);
        } else if (!Array.isArray(sr.results) || sr.results.length === 0) {
          setStatus(`sgdb-first: no grids found for "${term}". Open the SteamGridDB panel below to search manually.`, true);
        } else {
          const pick = sr.results.find((g) => g.url) || sr.results[0];
          setStatus(`sgdb-first: applying ${pick.width || '?'}x${pick.height || '?'} grid...`);
          const applied = await setBoxArtOverride(row.appId, pick.url);
          if (applied.ok) {
            row.override = { image_url: pick.url, source: 'manual' };
            if (indexes.overrideMap) indexes.overrideMap[row.appId] = row.override;
            setStatus(`sgdb-first: box art override set from SteamGridDB (${pick.width || '?'}x${pick.height || '?'}).`);
            refreshBody();
            const prev = document.getElementById('boxart-detail-preview');
            if (prev) { prev.src = pick.url; prev.style.opacity = 1; }
          } else {
            setStatus(`sgdb-first apply failed: ${applied.error || 'unknown'}`, true);
          }
        }
      } else if (action === 'set-url') {
        ctx = { appId: row.appId };
        modalInput.value = row.override?.image_url || row.cachedUrl || '';
        modalErr.hidden = true; modalErr.textContent = '';
        modal.hidden = false; modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => modalInput.focus(), 0);
      } else if (action === 'upload') {
        ctx = { appId: row.appId };
        uploadInp.click();
      } else if (action === 'clear') {
        if (!confirm(`Remove the admin override for ${row.appId}? This can't be undone.`)) return;
        setStatus('clearing override...');
        const result = await clearBoxArtOverride(row.appId);
        if (result.ok) {
          row.override = null;
          if (indexes.overrideMap) delete indexes.overrideMap[row.appId];
          setStatus('override cleared');
          refreshBody();
        } else setStatus(`clear failed: ${result.error || 'unknown'}`, true);
      }
    } finally {
      btn.disabled = false;
    }
  });

  modal.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-modal-action]');
    if (!btn || !ctx) return;
    if (btn.dataset.modalAction === 'cancel') {
      modal.hidden = true; ctx = null; return;
    }
    if (btn.dataset.modalAction === 'save') {
      const url = modalInput.value.trim();
      btn.disabled = true;
      modalErr.hidden = true;
      const result = await setBoxArtOverride(ctx.appId, url);
      btn.disabled = false;
      if (!result.ok) {
        modalErr.hidden = false;
        modalErr.textContent = result.error || 'save failed';
        return;
      }
      row.override = { app_id: ctx.appId, image_url: result.url, source: 'manual', updated_at: new Date().toISOString() };
      if (!indexes.overrideMap) indexes.overrideMap = {};
      indexes.overrideMap[ctx.appId] = row.override;
      modal.hidden = true; ctx = null;
      setStatus('override saved');
      refreshBody();
    }
  }, { once: false });

  uploadInp.addEventListener('change', async () => {
    const file = uploadInp.files?.[0];
    if (!file || !ctx) { uploadInp.value = ''; return; }
    setStatus('uploading...');
    const result = await uploadBoxArtOverride(ctx.appId, file);
    uploadInp.value = '';
    if (!result.ok) return setStatus(`upload failed: ${result.error || 'unknown'}`, true);
    row.override = { app_id: ctx.appId, image_url: result.url, source: 'upload', updated_at: new Date().toISOString() };
    if (!indexes.overrideMap) indexes.overrideMap = {};
    indexes.overrideMap[ctx.appId] = row.override;
    ctx = null;
    setStatus('upload saved');
    refreshBody();
  }, { once: false });
}
