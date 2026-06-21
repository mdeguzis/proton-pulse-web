import { escapeHtml, fmtDate } from '../utils.js?v=86489fcb';
import { fetchPendingReports, approveReport } from '../api/pending.js?v=e38fa2f3';

export async function renderPending(session, { onApproved } = {}) {
  const loading = document.getElementById('pending-loading');
  const empty = document.getElementById('pending-empty');
  const table = document.getElementById('pending-table');
  const tbody = document.getElementById('pending-tbody');

  loading.hidden = false;
  empty.hidden = true;
  table.hidden = true;

  try {
    const reports = await fetchPendingReports(session);
    loading.hidden = true;

    if (!reports.length) {
      empty.hidden = false;
      return;
    }

    table.hidden = false;
    tbody.innerHTML = reports.map(r => {
      const author = escapeHtml(r.proton_pulse_user_id?.slice(0, 8) || r.client_id?.slice(0, 8) || 'anonymous');
      const game = escapeHtml(r.app_id ? `App ${r.app_id}` : 'Unknown');
      const date = escapeHtml(fmtDate(r.created_at));
      const rating = escapeHtml(r.rating || '?');
      return `<tr data-report-id="${r.id}">
        <td><a class="admin-link" href="app.html#/app/${r.app_id}" target="_blank">${game}</a></td>
        <td>${author}</td>
        <td>${rating}</td>
        <td>${date}</td>
        <td><button class="admin-btn admin-btn--ok admin-btn--sm" data-action="approve" data-report='${escapeHtml(JSON.stringify(r))}'>Approve</button></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-action="approve"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const report = JSON.parse(btn.dataset.report);
        btn.disabled = true;
        btn.textContent = 'Approving...';
        try {
          await approveReport(session, report);
          btn.closest('tr').remove();
          if (!tbody.children.length) {
            table.hidden = true;
            empty.hidden = false;
          }
          onApproved?.();
        } catch (e) {
          btn.textContent = 'Failed';
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}
