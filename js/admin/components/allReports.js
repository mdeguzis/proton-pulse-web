import { escapeHtml, fmtDateTime } from '../utils.js?v=86489fcb';
import { fetchAllReports } from '../api/allReports.js?v=86dc6b4e';

export async function renderAllReports(session) {
  const loading = document.getElementById('all-reports-loading');
  const empty   = document.getElementById('all-reports-empty');
  const table   = document.getElementById('all-reports-table');
  const tbody   = document.getElementById('all-reports-tbody');
  const countEl = document.getElementById('all-reports-count');
  const search  = document.getElementById('all-reports-search');

  loading.hidden = false;
  empty.hidden   = true;
  table.hidden   = true;
  if (countEl) countEl.hidden = true;

  try {
    const q = search ? search.value.trim() : '';
    const reports = await fetchAllReports(session, { search: q });

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

      const uid = r.proton_pulse_user_id || null;
      const cid = r.client_id || null;
      const userObj = escapeHtml(JSON.stringify({ proton_pulse_user_id: uid, client_id: cid, username: uid || cid || 'anon' }));
      const userBtn = `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="view-user-detail" data-userobj='${userObj}'>Details</button>`;

      const flagged = r.is_flagged;
      const hidden  = r.is_hidden;
      const status  = (flagged || hidden)
        ? [
            flagged ? '<span class="admin-badge admin-badge--warn">flagged</span>' : '',
            hidden  ? '<span class="admin-badge admin-badge--muted">hidden</span>'  : '',
          ].filter(Boolean).join(' ')
        : '<span class="admin-badge admin-badge--ok">ok</span>';

      return `<tr>
        <td>${appLink}</td>
        <td>${title}</td>
        <td>${rating}</td>
        <td>${source}</td>
        <td>${userBtn}</td>
        <td>${date}</td>
        <td>${status}</td>
      </tr>`;
    }).join('');

    table.hidden = false;
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}
