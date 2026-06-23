import { escapeHtml, fmtDateTime } from '../utils.js?v=86489fcb';
import { fetchAllReports } from '../api/allReports.js?v=d8f732fd';

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
      const appLink = r.app_id
        ? `<a class="admin-link" href="app.html#/app/${r.app_id}" target="_blank">App ${escapeHtml(String(r.app_id))}</a>`
        : 'Unknown';
      const title   = escapeHtml(r.title || '');
      const rating  = escapeHtml(r.rating || '');
      const source  = escapeHtml(r.source || '');
      const user    = escapeHtml(r.proton_pulse_user_id || r.client_id || 'anon');
      const date    = escapeHtml(fmtDateTime(r.created_at));
      const badges  = [
        r.is_flagged ? '<span class="admin-badge admin-badge--warn">flagged</span>' : '',
        r.is_hidden  ? '<span class="admin-badge admin-badge--muted">hidden</span>'  : '',
      ].filter(Boolean).join(' ');
      return `<tr>
        <td>${appLink}</td>
        <td>${title}</td>
        <td>${rating}</td>
        <td>${source}</td>
        <td><code style="font-size:0.75rem">${user.slice(0, 16)}</code></td>
        <td>${date}</td>
        <td>${badges}</td>
      </tr>`;
    }).join('');

    table.hidden = false;
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}
