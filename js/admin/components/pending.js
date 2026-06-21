import { escapeHtml, fmtDate } from '../utils.js?v=86489fcb';
import { fetchPendingReports, approveReport } from '../api/pending.js?v=b722b8eb';

export async function renderPending(session, { onApproved } = {}) {
  const loading = document.getElementById('pending-loading');
  const empty = document.getElementById('pending-empty');
  const table = document.getElementById('pending-table');
  const tbody = document.getElementById('pending-tbody');
  const detail = document.getElementById('pending-detail');

  loading.hidden = false;
  empty.hidden = true;
  table.hidden = true;
  if (detail) detail.hidden = true;

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
      const game = escapeHtml(`App ${r.app_id}`);
      const date = escapeHtml(fmtDate(r.created_at));
      const rating = escapeHtml(r.rating || '?');
      return `<tr data-report-id="${r.id}">
        <td>#${r.id}</td>
        <td>${game}</td>
        <td>${author}</td>
        <td>${rating}</td>
        <td>${date}</td>
        <td>
          <button class="admin-btn admin-btn--sm" data-action="review" data-report='${escapeHtml(JSON.stringify(r))}'>Review</button>
          <button class="admin-btn admin-btn--ok admin-btn--sm" data-action="approve" data-report='${escapeHtml(JSON.stringify(r))}'>Approve</button>
        </td>
      </tr>`;
    }).join('');

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const report = JSON.parse(btn.dataset.report);

      if (btn.dataset.action === 'review') {
        showReviewDetail(report);
        return;
      }

      if (btn.dataset.action === 'approve') {
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
      }
    });
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}

function showReviewDetail(report) {
  const detail = document.getElementById('pending-detail');
  const table = document.getElementById('pending-table');
  if (!detail) return;

  table.hidden = true;
  detail.hidden = false;

  const fields = [
    ['Report ID', `#${report.id}`],
    ['App ID', report.app_id],
    ['Rating', report.rating || '(not set)'],
    ['GPU', report.gpu || '(not set)'],
    ['OS', report.os || '(not set)'],
    ['Notes', report.notes || '(none)'],
    ['Submitted', report.created_at ? new Date(report.created_at).toLocaleString() : '?'],
    ['Author', report.proton_pulse_user_id || report.client_id || 'anonymous'],
  ];

  detail.innerHTML = `
    <button class="admin-btn admin-btn--sm" id="pending-back-btn" style="margin-bottom:12px">Back to list</button>
    <div class="admin-card">
      <div class="admin-subhead">Report Review (Read-only)</div>
      <table class="admin-table">
        <tbody>
          ${fields.map(([label, value]) => `
            <tr>
              <td style="font-weight:600;color:var(--muted);width:120px">${escapeHtml(label)}</td>
              <td>${escapeHtml(String(value))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  detail.querySelector('#pending-back-btn')?.addEventListener('click', () => {
    detail.hidden = true;
    table.hidden = false;
  });
}
