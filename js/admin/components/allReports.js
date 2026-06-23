import { escapeHtml, fmtDateTime } from '../utils.js?v=86489fcb';
import { fetchAllReports } from '../api/allReports.js?v=3e62862a';

function statusBadges(isF, isH) {
  if (isF || isH) {
    return [
      isF ? '<span class="admin-badge admin-badge--warn">flagged</span>' : '',
      isH ? '<span class="admin-badge admin-badge--muted">hidden</span>'  : '',
    ].filter(Boolean).join(' ');
  }
  return '';
}

function actionBtns(id, isF, isH) {
  const rid = escapeHtml(String(id));
  if (isH || isF) {
    return `<button class="admin-btn admin-btn--ok admin-btn--sm" data-action="ar-release" data-rid="${rid}">Release</button>`;
  }
  return [
    `<button class="admin-btn admin-btn--warn admin-btn--sm" data-action="ar-flag" data-rid="${rid}">Flag</button>`,
    `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="ar-hide" data-rid="${rid}">Hide</button>`,
  ].join(' ');
}

export async function renderAllReports(session) {
  const loading   = document.getElementById('all-reports-loading');
  const empty     = document.getElementById('all-reports-empty');
  const table     = document.getElementById('all-reports-table');
  const tbody     = document.getElementById('all-reports-tbody');
  const countEl   = document.getElementById('all-reports-count');
  const searchEl  = document.getElementById('all-reports-search');
  const statusEl  = document.getElementById('all-reports-status-filter');

  loading.hidden = false;
  empty.hidden   = true;
  table.hidden   = true;
  if (countEl) countEl.hidden = true;

  try {
    const q      = searchEl ? searchEl.value.trim() : '';
    const status = statusEl ? statusEl.value : '';
    const reports = await fetchAllReports(session, { search: q, status });

    loading.hidden = true;

    if (!reports.length) {
      empty.hidden = false;
      return;
    }

    if (countEl) {
      countEl.textContent = `${reports.length} report${reports.length !== 1 ? 's' : ''}`;
      countEl.hidden = false;
    }

    tbody.innerHTML = reports.map(r => {
      const appId   = r.app_id ? escapeHtml(String(r.app_id)) : null;
      const appLink = appId
        ? `<a class="admin-link" href="app.html#/app/${appId}" target="_blank">App ${appId}</a>`
        : 'Unknown';
      const title  = escapeHtml(r.title || '');
      const rating = escapeHtml(r.rating || '');
      const source = escapeHtml(r.source || '');
      const date   = escapeHtml(fmtDateTime(r.created_at));
      const uid    = r.proton_pulse_user_id || null;
      const cid    = r.client_id || null;
      const userObj = escapeHtml(JSON.stringify({ proton_pulse_user_id: uid, client_id: cid, username: uid || cid || 'anon' }));
      const userBtn = `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="view-user-detail" data-userobj='${userObj}'>Details</button>`;

      return `<tr data-rid="${escapeHtml(String(r.id))}">
        <td>${appLink}</td>
        <td>${title}</td>
        <td>${rating}</td>
        <td>${source}</td>
        <td>${userBtn}</td>
        <td>${date}</td>
        <td class="ar-status">${statusBadges(r.is_flagged, r.is_hidden)}</td>
        <td class="ar-actions">${actionBtns(r.id, r.is_flagged, r.is_hidden)}</td>
      </tr>`;
    }).join('');

    table.hidden = false;
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}

export function updateAllReportsRow(id, isF, isH) {
  const row = document.querySelector(`#all-reports-tbody tr[data-rid="${CSS.escape(String(id))}"]`);
  if (!row) return;
  const statusCell  = row.querySelector('.ar-status');
  const actionsCell = row.querySelector('.ar-actions');
  if (statusCell)  statusCell.innerHTML  = statusBadges(isF, isH);
  if (actionsCell) actionsCell.innerHTML = actionBtns(id, isF, isH);
}
