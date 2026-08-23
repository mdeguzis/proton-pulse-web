// depotTracking (admin component): renders the Depot Tracking admin panel
// (#230). Aggregate cards + per-app table with expand-to-see-details. Read
// only for the MVP; workflow-dispatch + cache invalidation actions land in
// a follow-up so the UI can ship without a new signed-in-admin edge fn.

import { fetchDepotTrackingDossier, summarizeApps } from '../api/depotTracking.js?v=4b0f8cc0';

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const min = Math.round(diff / 60000);
  if (min < 60)  return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48)    return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function statusPill(status) {
  const cls = status === 'ok' ? 'ok' : status === 'no_public_manifest' ? 'warn' : 'err';
  const label = status === 'no_public_manifest' ? 'no manifest' : status;
  return `<span class="depot-pill depot-pill--${cls}">${esc(label || 'unknown')}</span>`;
}

/**
 * Render the panel into the given host element. Idempotent: re-renders on
 * search input + a manual Refresh button. Not paginated for the MVP --
 * fetchDepotTrackingDossier caps at 500 apps which is fine while our
 * tracked set is small.
 */
export async function renderDepotTracking(host) {
  if (!host) return;
  host.innerHTML = `
    <div class="depot-tracking">
      <div class="depot-controls">
        <input type="text" id="depot-search" class="admin-input admin-input--wide" placeholder="Filter by app id or status...">
        <button type="button" id="depot-refresh" class="admin-btn">Refresh</button>
      </div>
      <div class="depot-agg" id="depot-agg"></div>
      <div class="admin-table-scroll">
        <table class="admin-table depot-table">
          <thead>
            <tr>
              <th>App ID</th>
              <th>Status</th>
              <th>Depots</th>
              <th>OSes</th>
              <th>Fetched</th>
              <th>Latest observation</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="depot-tbody">
            <tr><td colspan="7" class="admin-loading">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  let dossier = null;

  async function load() {
    const tbody = host.querySelector('#depot-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="admin-loading">Loading...</td></tr>`;
    try {
      dossier = await fetchDepotTrackingDossier();
      applyFilter(host.querySelector('#depot-search')?.value || '');
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="admin-error">${esc(e.message || e)}</td></tr>`;
    }
  }

  function applyFilter(query) {
    if (!dossier) return;
    const q = query.trim().toLowerCase();
    const rows = dossier.apps.filter(a => {
      if (!q) return true;
      if (String(a.app_id).includes(q)) return true;
      if ((a.app_status || '').toLowerCase().includes(q)) return true;
      return false;
    });
    renderAggregate(host.querySelector('#depot-agg'), rows.length === dossier.apps.length
      ? dossier.aggregate
      : summarizeApps(rows));
    renderRows(host.querySelector('#depot-tbody'), rows);
  }

  host.querySelector('#depot-refresh')?.addEventListener('click', load);
  host.querySelector('#depot-search')?.addEventListener('input', (e) => applyFilter(e.target.value));

  await load();
}

function renderAggregate(el, agg) {
  if (!el) return;
  const card = (label, value, sub = '') => `
    <div class="depot-card">
      <div class="depot-card-label">${esc(label)}</div>
      <div class="depot-card-value">${esc(String(value))}</div>
      ${sub ? `<div class="depot-card-sub">${esc(sub)}</div>` : ''}
    </div>`;
  el.innerHTML = [
    card('Total tracked',   agg.total),
    card('OK',              agg.ok),
    card('No manifest',     agg.noManifest),
    card('Errors',          agg.error),
    card('Newest fetch',    fmtDate(agg.newest), relTime(agg.newest)),
    card('Manifests changed 24h', agg.updatedIn24h),
    card('Changed 7d',      agg.updatedIn7d),
    card('Changed 30d',     agg.updatedIn30d),
  ].join('');
}

function renderRows(tbody, rows) {
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">No apps match the current filter.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(a => renderRow(a)).join('');
  // Wire per-row expand toggles. Delegated because innerHTML replacement
  // wipes any per-element listeners we could have attached above.
  tbody.querySelectorAll('[data-depot-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = tbody.querySelector(`[data-depot-detail="${btn.dataset.depotToggle}"]`);
      if (!target) return;
      const open = target.classList.toggle('depot-detail--open');
      btn.textContent = open ? 'Hide' : 'Details';
    });
  });
}

function renderRow(a) {
  const oses = [...new Set((a.depots || []).map(d => d.os))].sort();
  const osChips = oses.length
    ? oses.map(o => `<span class="depot-os-chip depot-os-chip--${esc(o)}">${esc(o)}</span>`).join(' ')
    : '<span class="admin-muted">-</span>';
  const historyPart = a.history?.newestFirstObserved
    ? `${fmtDate(a.history.newestFirstObserved)} <span class="admin-muted">(${relTime(a.history.newestFirstObserved)})</span>`
    : '<span class="admin-muted">no history yet</span>';
  const key = `app-${a.app_id}`;
  return `
    <tr class="depot-row">
      <td><a href="app.html#/app/${esc(String(a.app_id))}" target="_blank" rel="noopener">${esc(String(a.app_id))}</a></td>
      <td>${statusPill(a.app_status)}${a.error ? `<div class="depot-row-error" title="${esc(a.error)}">${esc(a.error.slice(0, 80))}${a.error.length > 80 ? '...' : ''}</div>` : ''}</td>
      <td>${a.depot_count ?? (a.depots || []).length}</td>
      <td>${osChips}</td>
      <td>${fmtDate(a.fetched_at)} <span class="admin-muted">(${relTime(a.fetched_at)})</span></td>
      <td>${historyPart}</td>
      <td><button type="button" class="admin-btn admin-btn--small" data-depot-toggle="${esc(key)}">Details</button></td>
    </tr>
    <tr class="depot-detail" data-depot-detail="${esc(key)}">
      <td colspan="7">
        ${renderDetail(a)}
      </td>
    </tr>`;
}

function renderDetail(a) {
  const depots = a.depots || [];
  if (depots.length === 0) return '<div class="admin-muted">No depot rows recorded.</div>';
  const depotRows = depots.map(d => `
    <tr>
      <td>${esc(d.os)}</td>
      <td>${esc(String(d.depot_id))}</td>
      <td class="depot-mono">${esc(d.manifest_id || '-')}</td>
      <td>${fmtDate(d.last_updated_at)}</td>
    </tr>`).join('');
  const perOs = a.history?.perOs || {};
  const historyRows = Object.entries(perOs).map(([os, h]) => `
    <tr>
      <td>${esc(os)}</td>
      <td>${h.count}</td>
      <td>${fmtDate(h.oldestFirstObserved)}</td>
      <td>${fmtDate(h.newestFirstObserved)}</td>
    </tr>`).join('');
  return `
    <div class="depot-detail-grid">
      <div>
        <div class="depot-detail-title">Current depots</div>
        <table class="depot-inner-table">
          <thead><tr><th>OS</th><th>Depot</th><th>Manifest</th><th>Last update</th></tr></thead>
          <tbody>${depotRows}</tbody>
        </table>
      </div>
      <div>
        <div class="depot-detail-title">Manifest history per OS</div>
        ${historyRows
          ? `<table class="depot-inner-table"><thead><tr><th>OS</th><th>Count</th><th>First observed</th><th>Latest observation</th></tr></thead><tbody>${historyRows}</tbody></table>`
          : '<div class="admin-muted">No history rows yet. Nightly runs will populate this once a manifest_id changes.</div>'}
      </div>
    </div>`;
}
