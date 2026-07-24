// Admin "Games" tab -- the manual fallback for bad app IDs (#234).
//
// Three sub-sections:
//   1. Hidden games:   admin blacklist. Row: app_id / title / reason /
//                      hidden by / when / unhide.
//   2. Remapped IDs:   admin-forced redirects. Row: from / to / reason /
//                      when / clear.
//   3. Pipeline suspects: read-only view of app-id-redirects.json (from
//                      #233's validator). Admin can promote a suspect to a
//                      real remap or hide with one click.
//
// The panel writes go through Supabase (game_hides / game_remaps tables).
// RLS on both is gated by the manage_games permission -- super_admin also
// gets it via the current_user_has_permission short-circuit. Consumers
// (frontend filter, pipeline bake) are a follow-up ticket; this MVP just
// gives moderators the write path.

import { dataUrl } from '../../lib/data-url.js?v=97f09986';
import { escapeHtml } from '../utils.js?v=2668b2f0';
import {
  listGameHides, upsertGameHide, deleteGameHide,
  listGameRemaps, upsertGameRemap, deleteGameRemap,
  loadPipelineSuspects,
} from '../api/gameManager.js?v=596babe0';

// Small in-memory cache of the search-index so we can render titles next
// to raw app ids. Fetched once when the tab mounts.
let _searchIndex = null;
async function _loadIndex() {
  if (_searchIndex) return _searchIndex;
  try {
    const res = await fetch(await dataUrl('search-index.json'));
    _searchIndex = res.ok ? await res.json() : [];
  } catch { _searchIndex = []; }
  return _searchIndex;
}

// Map { app_id -> title } for O(1) lookups when rendering rows.
async function _titleMap() {
  const idx = await _loadIndex();
  const out = new Map();
  for (const row of idx) {
    if (Array.isArray(row) && row[0]) out.set(String(row[0]), String(row[1] || ''));
  }
  return out;
}

function _fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function _titleFor(titleMap, appId) {
  const t = titleMap.get(String(appId));
  return t || `App ${appId}`;
}

// ── Public entry point ────────────────────────────────────────────────

export async function renderGameManager() {
  const el = document.getElementById('game-manager-content');
  if (!el) return;
  el.innerHTML = `<div class="admin-loading">Loading Game Manager...</div>`;

  const [hides, remaps, suspects, titleMap] = await Promise.all([
    listGameHides(),
    listGameRemaps(),
    loadPipelineSuspects(),
    _titleMap(),
  ]);

  el.innerHTML = `
    <div class="admin-card gm-card">
      <div class="admin-subhead">Hidden games</div>
      <p class="admin-hint">Blacklist an app id so it stops appearing in the site's search + list pages. Requires a reason so the paper trail explains the take-down. Frontend consumer is a follow-up ticket -- for now the panel just writes the row.</p>
      <form class="gm-form" id="gm-hide-form">
        <input class="admin-input gm-form-id" name="app_id" placeholder="App ID (e.g. 26670 or gog:123)" required>
        <input class="admin-input gm-form-reason" name="reason" placeholder="Reason (required)" required>
        <button class="admin-btn admin-btn--primary" type="submit">Hide</button>
      </form>
      <div id="gm-hide-status" class="admin-hint" hidden></div>
      <table class="admin-table gm-table">
        <thead><tr><th>App ID</th><th>Title</th><th>Reason</th><th>Hidden</th><th></th></tr></thead>
        <tbody id="gm-hides-body"></tbody>
      </table>
    </div>

    <div class="admin-card gm-card">
      <div class="admin-subhead">Remapped IDs</div>
      <p class="admin-hint">Redirect a bad app id to the correct one. Strongly overrules the pipeline's <code>replaced_by</code> detection when Steam's own redirects are wrong or missing. Reason required.</p>
      <form class="gm-form" id="gm-remap-form">
        <input class="admin-input gm-form-id" name="from_app_id" placeholder="From App ID" required>
        <input class="admin-input gm-form-id" name="to_app_id" placeholder="To App ID" required>
        <input class="admin-input gm-form-reason" name="reason" placeholder="Reason (required)" required>
        <button class="admin-btn admin-btn--primary" type="submit">Remap</button>
      </form>
      <div id="gm-remap-status" class="admin-hint" hidden></div>
      <table class="admin-table gm-table">
        <thead><tr><th>From</th><th>To</th><th>Reason</th><th>Updated</th><th></th></tr></thead>
        <tbody id="gm-remaps-body"></tbody>
      </table>
    </div>

    <div class="admin-card gm-card">
      <div class="admin-subhead">Pipeline-flagged suspects</div>
      <p class="admin-hint">Read-only view of <code>app-id-redirects.json</code>, populated by the pipeline validator (#233 / #235). Empty when the file hasn't been published yet.</p>
      <table class="admin-table gm-table">
        <thead><tr><th>App ID</th><th>Title</th><th>Status</th><th>Suggested target</th><th></th></tr></thead>
        <tbody id="gm-suspects-body"></tbody>
      </table>
    </div>
  `;

  _renderHides(el, hides, titleMap);
  _renderRemaps(el, remaps, titleMap);
  _renderSuspects(el, suspects, titleMap);
  _wireForms(el, titleMap);

  // Deep-link support: ?tab=games&appid=<id> pre-fills both the Hide
  // form and the From-remap form + focuses the hide reason input so an
  // admin who jumped here from the Box Art detail can act in one click.
  const params = new URLSearchParams(window.location.search);
  const preAppId = params.get('appid');
  if (preAppId) {
    const hideId = el.querySelector('#gm-hide-form input[name="app_id"]');
    const hideReason = el.querySelector('#gm-hide-form input[name="reason"]');
    const remapFrom = el.querySelector('#gm-remap-form input[name="from_app_id"]');
    if (hideId) hideId.value = preAppId;
    if (remapFrom) remapFrom.value = preAppId;
    if (hideReason) setTimeout(() => hideReason.focus(), 0);
  }
}

// ── Section renderers ─────────────────────────────────────────────────

function _renderHides(root, rows, titleMap) {
  const tbody = root.querySelector('#gm-hides-body');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-empty">No games hidden.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-app-id="${escapeHtml(r.app_id)}">
      <td><code>${escapeHtml(r.app_id)}</code></td>
      <td><a href="app.html#/app/${encodeURIComponent(r.app_id)}" target="_blank" rel="noopener">${escapeHtml(_titleFor(titleMap, r.app_id))}</a></td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${escapeHtml(_fmtDate(r.hidden_at))}</td>
      <td><button class="admin-btn" data-action="unhide" data-app-id="${escapeHtml(r.app_id)}">Unhide</button></td>
    </tr>
  `).join('');
}

function _renderRemaps(root, rows, titleMap) {
  const tbody = root.querySelector('#gm-remaps-body');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-empty">No remaps set.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r) => `
    <tr data-app-id="${escapeHtml(r.from_app_id)}">
      <td><code>${escapeHtml(r.from_app_id)}</code></td>
      <td><a href="app.html#/app/${encodeURIComponent(r.to_app_id)}" target="_blank" rel="noopener"><code>${escapeHtml(r.to_app_id)}</code> ${escapeHtml(_titleFor(titleMap, r.to_app_id))}</a></td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${escapeHtml(_fmtDate(r.updated_at || r.created_at))}</td>
      <td><button class="admin-btn" data-action="clear-remap" data-app-id="${escapeHtml(r.from_app_id)}">Clear</button></td>
    </tr>
  `).join('');
}

function _renderSuspects(root, suspects, titleMap) {
  const tbody = root.querySelector('#gm-suspects-body');
  if (!tbody) return;
  const rows = Object.entries(suspects || {});
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-empty">No pipeline-flagged suspects. This list is populated once the validator has run and pushed <code>app-id-redirects.json</code> to gh-pages.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(([appId, entry]) => {
    const status = entry.status || 'unknown';
    const target = entry.replaced_by || '';
    const action = target
      ? `<button class="admin-btn admin-btn--primary" data-action="promote-remap" data-app-id="${escapeHtml(appId)}" data-target="${escapeHtml(target)}">Remap -> ${escapeHtml(target)}</button>`
      : `<button class="admin-btn" data-action="promote-hide" data-app-id="${escapeHtml(appId)}">Hide</button>`;
    return `
      <tr data-app-id="${escapeHtml(appId)}">
        <td><code>${escapeHtml(appId)}</code></td>
        <td>${escapeHtml(_titleFor(titleMap, appId))}</td>
        <td><span class="gm-suspect-status gm-suspect-status--${escapeHtml(status)}">${escapeHtml(status)}</span></td>
        <td>${target ? `<code>${escapeHtml(target)}</code>` : '-'}</td>
        <td>${action}</td>
      </tr>
    `;
  }).join('');
}

// ── Form + row-action wiring ─────────────────────────────────────────

function _setStatus(el, id, text, tone = 'info') {
  const s = el.querySelector(`#${id}`);
  if (!s) return;
  s.hidden = false;
  s.textContent = text;
  s.className = 'admin-hint' + (tone === 'error' ? ' admin-error' : '');
}

function _wireForms(el, titleMap) {
  const hideForm = el.querySelector('#gm-hide-form');
  hideForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(hideForm);
    const res = await upsertGameHide(f.get('app_id'), f.get('reason'));
    if (!res.ok) return _setStatus(el, 'gm-hide-status', `Failed: ${res.error}`, 'error');
    hideForm.reset();
    const hides = await listGameHides();
    _renderHides(el, hides, titleMap);
    _setStatus(el, 'gm-hide-status', 'Saved.');
  });

  const remapForm = el.querySelector('#gm-remap-form');
  remapForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(remapForm);
    const res = await upsertGameRemap(f.get('from_app_id'), f.get('to_app_id'), f.get('reason'));
    if (!res.ok) return _setStatus(el, 'gm-remap-status', `Failed: ${res.error}`, 'error');
    remapForm.reset();
    const remaps = await listGameRemaps();
    _renderRemaps(el, remaps, titleMap);
    _setStatus(el, 'gm-remap-status', 'Saved.');
  });

  // Row-action delegation. Unhide + clear + promote-* all live here so a
  // fresh render doesn't require re-wiring individual buttons.
  el.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const appId = btn.dataset.appId;
    if (!action || !appId) return;

    if (action === 'unhide') {
      const res = await deleteGameHide(appId);
      if (!res.ok) return _setStatus(el, 'gm-hide-status', `Failed: ${res.error}`, 'error');
      _renderHides(el, await listGameHides(), titleMap);
      return;
    }

    if (action === 'clear-remap') {
      const res = await deleteGameRemap(appId);
      if (!res.ok) return _setStatus(el, 'gm-remap-status', `Failed: ${res.error}`, 'error');
      _renderRemaps(el, await listGameRemaps(), titleMap);
      return;
    }

    if (action === 'promote-remap') {
      const target = btn.dataset.target;
      const reason = window.prompt(
        `Reason to remap ${appId} -> ${target}?\n(Pipeline validator flagged this. Cancel to skip.)`,
        'Pipeline validator flagged as replaced.',
      );
      if (!reason || !reason.trim()) return;
      const res = await upsertGameRemap(appId, target, reason);
      if (!res.ok) return _setStatus(el, 'gm-remap-status', `Failed: ${res.error}`, 'error');
      _renderRemaps(el, await listGameRemaps(), titleMap);
      return;
    }

    if (action === 'promote-hide') {
      const reason = window.prompt(
        `Reason to hide ${appId}?\n(Pipeline validator flagged this as dead. Cancel to skip.)`,
        'Pipeline validator flagged as dead app id.',
      );
      if (!reason || !reason.trim()) return;
      const res = await upsertGameHide(appId, reason);
      if (!res.ok) return _setStatus(el, 'gm-hide-status', `Failed: ${res.error}`, 'error');
      _renderHides(el, await listGameHides(), titleMap);
    }
  });
}
