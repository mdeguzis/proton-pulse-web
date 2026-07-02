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

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { escapeHtml } from '../utils.js?v=bd5a67c2';
import {
  probeSteamHeader, refetchSteamHeader, refetchNonSteamHeader, refetchSgdbHeader,
  setBoxArtOverride, uploadBoxArtOverride, clearBoxArtOverride, listBoxArtOverrides,
} from '../api/boxart.js?v=42fb729e';

const PAGE_SIZE = 25;
const BATCH_SIZE = 10;              // parallel probes per batch when Probe all runs
const BATCH_YIELD_MS = 50;          // pause between batches so the UI stays responsive

let _cache = null;
async function _loadIndexes() {
  if (_cache) return _cache;
  const [siRes, giRes, nsRes, overrides] = await Promise.all([
    fetch(await dataUrl('search-index.json')).catch(() => null),
    fetch(await dataUrl('game-images.json')).catch(() => null),
    fetch(await dataUrl('nonsteam-images.json')).catch(() => null),
    listBoxArtOverrides().catch(() => ({ ok: false, rows: [] })),
  ]);
  const searchIndex = (siRes && siRes.ok) ? await siRes.json().catch(() => []) : [];
  const gameImages  = (giRes && giRes.ok) ? await giRes.json().catch(() => ({})) : {};
  const nonSteam    = (nsRes && nsRes.ok) ? await nsRes.json().catch(() => ({})) : {};
  // Admin overrides beat all other sources; keyed by app_id for O(1)
  // lookup during row build + status render.
  const overrideMap = {};
  for (const row of (overrides.rows || [])) {
    if (row?.app_id) overrideMap[String(row.app_id)] = row;
  }
  _cache = { searchIndex, gameImages, nonSteam, overrideMap };
  return _cache;
}

// Derive the same status the Status column shows, without probing.
// Admin override beats everything; otherwise the presence of a cached
// URL and store type determine the label.
function _deriveStatus(type, cachedUrl, hasOverride) {
  if (hasOverride) return 'override';
  if (type === 'steam') return cachedUrl ? 'fallback_cached' : 'default_cdn';
  return cachedUrl ? 'cached' : 'missing';
}

// search-index shape: [appId, title, tier, pdb, pulse, appType, releaseYear, delisted, adult]
function _buildRows({ searchIndex, gameImages, nonSteam, overrideMap }, { store, textFilter, scope, status }) {
  const q = String(textFilter || '').trim().toLowerCase();
  const rows = [];
  for (const row of searchIndex) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const appId = String(row[0]);
    const title = String(row[1] || '');
    const type  = row[5] || (appId.startsWith('gog:') ? 'gog' : appId.startsWith('epic:') ? 'epic' : 'steam');
    if (store && store !== 'all' && store !== type) continue;
    if (q && !title.toLowerCase().includes(q) && !appId.startsWith(q)) continue;
    const override = overrideMap ? overrideMap[appId] : null;
    let cachedUrl = null;
    if (type === 'steam') cachedUrl = gameImages[appId] || null;
    else                   cachedUrl = nonSteam[appId] || null;
    const derivedStatus = _deriveStatus(type, cachedUrl, !!override);
    // scope filter: has = row is presumed to display box art
    // (Steam default CDN OR any cached URL OR override). missing =
    // only rows we know don't display box art (non-Steam with no
    // cached URL, no override, and no store CDN fallback).
    if (scope === 'has'     && derivedStatus === 'missing') continue;
    if (scope === 'missing' && derivedStatus !== 'missing') continue;
    // status filter: exact match against derived status label.
    if (status && status !== 'all' && status !== derivedStatus) continue;
    rows.push({ appId, title, type, cachedUrl, derivedStatus, override });
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
      <button class="admin-btn" id="boxart-probe-visible-btn" title="Probe every row on the current page">Probe visible page</button>
      <button class="admin-btn admin-btn--primary" id="boxart-probe-all-btn" title="Probe every row that matches the current filters in bounded batches">Probe all (filtered)</button>
      <button class="admin-btn" id="boxart-cancel-btn" hidden>Cancel</button>
    </div>
    <p class="admin-hint" style="margin:8px 0 12px">
      Loads search-index.json + game-images.json + nonsteam-images.json + box_art_overrides in this browser.
      Probe HEADs the canonical URL. Refetch asks the store's API (Steam appdetails / SGDB) for the current URL.
      Set URL and Upload write to box_art_overrides -- the pipeline preserves those on every rerun. Clear removes the override.
    </p>
    <input type="file" id="boxart-upload-input" accept="image/png,image/jpeg,image/webp" style="display:none">
    <div id="boxart-modal-backdrop" class="admin-modal-backdrop" hidden aria-hidden="true">
      <div class="admin-modal" style="padding: 20px; min-width: 380px; max-width: 90vw">
        <h3 class="admin-modal-title">Set custom box art URL</h3>
        <p class="admin-modal-sub" style="margin:6px 0 12px">Overrides the CDN and pipeline fallbacks. Preserved across pipeline reruns until you Clear it.</p>
        <input type="url" id="boxart-modal-input" class="admin-input" placeholder="https://example.com/header.jpg" style="width:100%">
        <div class="admin-modal-actions" style="margin-top:14px">
          <button class="admin-btn" data-modal-action="cancel">Cancel</button>
          <button class="admin-btn admin-btn--primary" data-modal-action="save">Save override</button>
        </div>
        <p id="boxart-modal-error" class="admin-error" hidden style="margin-top:10px"></p>
      </div>
    </div>
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
        <button class="admin-btn" data-action="probe" title="HEAD the canonical URL">Probe</button>
        <button class="admin-btn" data-action="refetch" title="Ask the store's API for the current header URL">Refetch</button>
        <button class="admin-btn" data-action="sgdb" title="Fetch from SteamGridDB (community artwork)">SGDB</button>
        <button class="admin-btn" data-action="set-url" title="Set a custom URL that survives pipeline reruns">Set URL</button>
        <button class="admin-btn" data-action="upload" title="Upload an image (PNG/JPG/WebP, <= 2 MB)">Upload</button>
        <button class="admin-btn admin-btn--danger" data-action="clear" title="Remove the admin override" ${r.override ? '' : 'hidden'}>Clear</button>
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

async function _probeRow(tr, gameImages) {
  const appId = tr.dataset.appid;
  const type  = tr.dataset.store;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">probing...</span>';
  const result = type === 'steam'
    ? await probeSteamHeader(appId, gameImages[appId] || null)
    : await refetchNonSteamHeader(appId, tr.dataset.cached || null);
  _paintStatus(statusEl, result);
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
  return result;
}

async function _sgdbRow(tr) {
  const appId = tr.dataset.appid;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">fetching from SteamGridDB...</span>';
  const result = await refetchSgdbHeader(appId);
  _paintStatus(statusEl, result);
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

  const state = { store: 'all', textFilter: '', scope: 'all', status: 'all', page: 0, rows: [] };
  let cancelToken = { cancelled: false };

  function refilter() {
    state.rows = _buildRows(indexes, {
      store: state.store,
      textFilter: state.textFilter,
      scope: state.scope,
      status: state.status,
    });
    state.page = 0;
    _renderPage(state.rows, state.page);
  }

  const searchEl  = document.getElementById('boxart-search');
  const storeEl   = document.getElementById('boxart-store');
  const scopeEl   = document.getElementById('boxart-scope');
  const statusEl  = document.getElementById('boxart-status');
  const visBtn    = document.getElementById('boxart-probe-visible-btn');
  const allBtn    = document.getElementById('boxart-probe-all-btn');
  const cancelBtn = document.getElementById('boxart-cancel-btn');
  const progEl    = document.getElementById('boxart-batch-progress');
  const table     = document.getElementById('boxart-table');
  const pager     = document.getElementById('boxart-pager');

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
    cancelBtn.hidden = !running;
    progEl.hidden = !running;
  }

  visBtn.addEventListener('click', async () => {
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

  cancelBtn.addEventListener('click', () => {
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
    if (r) { r.override = null; r.derivedStatus = _deriveStatus(r.type, r.cachedUrl, false); }
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
