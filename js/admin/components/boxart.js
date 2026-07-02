// Admin "Missing Box Art" tab.
//
// Loads the current search-index + image caches, lets an admin scan a
// paginated slice for games whose header image doesn't resolve, and
// refetch the URL from the store's canonical API (Steam appdetails for
// Steam apps; URL re-probe for GOG / Epic). Each row shows the URL
// that was tried and the HTTP error if it failed.
//
// Deliberately client-side only: no server writes. Suggested URLs get
// dumped as a copy-pasteable JSON snippet the admin can drop into
// game-images.json / nonsteam-images.json in a follow-up PR.

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';
import { escapeHtml } from '../utils.js?v=bd5a67c2';
import { probeSteamHeader, refetchSteamHeader, refetchNonSteamHeader, probeImageUrl } from '../api/boxart.js?v=a5f6e2fb';

const PAGE_SIZE = 25;

let _cache = null;
async function _loadIndexes() {
  if (_cache) return _cache;
  const [siRes, giRes, nsRes] = await Promise.all([
    fetch(await dataUrl('search-index.json')).catch(() => null),
    fetch(await dataUrl('game-images.json')).catch(() => null),
    fetch(await dataUrl('nonsteam-images.json')).catch(() => null),
  ]);
  const searchIndex = (siRes && siRes.ok) ? await siRes.json().catch(() => []) : [];
  const gameImages  = (giRes && giRes.ok) ? await giRes.json().catch(() => ({})) : {};
  const nonSteam    = (nsRes && nsRes.ok) ? await nsRes.json().catch(() => ({})) : {};
  _cache = { searchIndex, gameImages, nonSteam };
  return _cache;
}

// Filter the search-index rows to the store + status the UI asks for.
// search-index shape: [appId, title, tier, pdb, pulse, appType, releaseYear, delisted, adult]
function _buildRows({ searchIndex, gameImages, nonSteam }, { store, textFilter }) {
  const q = String(textFilter || '').trim().toLowerCase();
  const rows = [];
  for (const row of searchIndex) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const appId = String(row[0]);
    const title = String(row[1] || '');
    const type  = row[5] || (appId.startsWith('gog:') ? 'gog' : appId.startsWith('epic:') ? 'epic' : 'steam');
    if (store && store !== 'all' && store !== type) continue;
    if (q && !title.toLowerCase().includes(q) && !appId.startsWith(q)) continue;
    // Cached URL if the pipeline has one on file.
    let cachedUrl = null;
    if (type === 'steam') {
      cachedUrl = gameImages[appId] || null;
    } else {
      cachedUrl = nonSteam[appId] || null;
    }
    rows.push({ appId, title, type, cachedUrl });
  }
  return rows;
}

function _renderShell() {
  return `
    <div class="admin-filters">
      <input type="text" id="boxart-search" class="admin-input admin-input--wide" placeholder="Search app ID or title...">
      <select id="boxart-store" class="admin-select">
        <option value="all">All stores</option>
        <option value="steam">Steam</option>
        <option value="gog">GOG</option>
        <option value="epic">Epic</option>
      </select>
      <label class="admin-label">
        <input type="checkbox" id="boxart-only-cached-fallback">
        Only games with a pipeline fallback URL on file
      </label>
      <button class="admin-btn" id="boxart-scan-btn">Scan visible page</button>
    </div>
    <p class="admin-hint" style="margin:8px 0 12px">
      Loads search-index.json + game-images.json + nonsteam-images.json in this browser
      and probes header images for the visible page (up to ${PAGE_SIZE} rows). "Refetch"
      hits the store's canonical API (Steam appdetails for Steam; URL re-probe for GOG/Epic)
      and reports the working URL or a human-readable error.
    </p>
    <div id="boxart-loading" class="admin-loading">Loading indexes...</div>
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

function _renderRow(r) {
  const cachedCell = r.cachedUrl
    ? `<a href="${escapeHtml(r.cachedUrl)}" target="_blank" rel="noopener" class="admin-link" title="${escapeHtml(r.cachedUrl)}">cached</a>`
    : '<span class="admin-muted">(none)</span>';
  return `
    <tr data-appid="${escapeHtml(r.appId)}" data-store="${escapeHtml(r.type)}" data-cached="${escapeHtml(r.cachedUrl || '')}">
      <td class="admin-col-title">${escapeHtml(r.title || '(no title)')}</td>
      <td><span class="admin-badge admin-badge--info">${r.type}</span></td>
      <td><code>${escapeHtml(r.appId)}</code></td>
      <td>${cachedCell}</td>
      <td class="boxart-status">-</td>
      <td>
        <button class="admin-btn" data-action="probe">Probe</button>
        <button class="admin-btn" data-action="refetch">Refetch</button>
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
  countEl.textContent = `${total.toLocaleString()} game(s) match · showing ${start + 1}-${Math.min(start + PAGE_SIZE, total)}`;
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
  let result;
  if (type === 'steam') {
    result = await probeSteamHeader(appId, gameImages[appId] || null);
  } else {
    result = await refetchNonSteamHeader(appId, tr.dataset.cached || null);
  }
  _paintStatus(statusEl, result);
  return result;
}

async function _refetchRow(tr) {
  const appId = tr.dataset.appid;
  const type  = tr.dataset.store;
  const statusEl = tr.querySelector('.boxart-status');
  statusEl.innerHTML = '<span class="admin-muted">refetching from source...</span>';
  let result;
  if (type === 'steam') {
    result = await refetchSteamHeader(appId);
  } else {
    // Re-probe the cached URL — GOG/Epic don't have a live-fetch equivalent.
    result = await refetchNonSteamHeader(appId, tr.dataset.cached || null);
  }
  _paintStatus(statusEl, result);
  return result;
}

function _paintStatus(el, result) {
  if (result.ok) {
    el.innerHTML = `<span class="admin-badge admin-badge--ok">OK</span> <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener" class="admin-link" title="${escapeHtml(result.url)}">view</a>`;
  } else {
    const status = result.status ? ` (${result.status})` : '';
    el.innerHTML = `<span class="admin-badge admin-badge--warn">FAIL</span> <span class="admin-muted" title="${escapeHtml(result.error || 'unknown')}">${escapeHtml((result.error || 'unknown') + status)}</span>`;
  }
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

  const state = { store: 'all', textFilter: '', onlyCached: false, page: 0, rows: [] };

  function refilter() {
    let rows = _buildRows(indexes, { store: state.store, textFilter: state.textFilter });
    if (state.onlyCached) rows = rows.filter(r => !!r.cachedUrl);
    state.rows = rows;
    state.page = 0;
    _renderPage(rows, state.page);
  }

  const searchEl = document.getElementById('boxart-search');
  const storeEl  = document.getElementById('boxart-store');
  const onlyEl   = document.getElementById('boxart-only-cached-fallback');
  const scanBtn  = document.getElementById('boxart-scan-btn');
  const table    = document.getElementById('boxart-table');
  const pager    = document.getElementById('boxart-pager');

  let debounce = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.textFilter = searchEl.value; refilter(); }, 200);
  });
  storeEl.addEventListener('change', () => { state.store = storeEl.value; refilter(); });
  onlyEl.addEventListener('change', () => { state.onlyCached = onlyEl.checked; refilter(); });

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning...';
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    for (const tr of rows) {
      // Sequential to avoid hammering CDNs from one browser.
      await _probeRow(tr, indexes.gameImages);
    }
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan visible page';
  });

  table.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    btn.disabled = true;
    try {
      if (btn.dataset.action === 'probe') await _probeRow(tr, indexes.gameImages);
      else if (btn.dataset.action === 'refetch') await _refetchRow(tr);
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
  });

  refilter();
}
