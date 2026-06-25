import { escapeHtml, fmtDateTime } from '../utils.js?v=bd5a67c2';
import { fetchPendingReports, approveReport } from '../api/pending.js?v=84292a58';

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
      const game = escapeHtml(r.app_id ? `App ${r.app_id}` : 'Unknown');
      const reportId = escapeHtml(r.id != null ? String(r.id).slice(0, 8) : '?');
      const date = escapeHtml(fmtDateTime(r.created_at));
      return `<tr data-report-id="${r.id}">
        <td><a class="admin-link" href="app.html#/app/${r.app_id}" target="_blank">${game}</a></td>
        <td><code>${reportId}</code></td>
        <td>${date}</td>
        <td>
          <button class="admin-btn admin-btn--sm" data-action="review" data-report='${escapeHtml(JSON.stringify(r))}'>Review</button>
        </td>
      </tr>`;
    }).join('');

    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const report = JSON.parse(btn.dataset.report);
      if (btn.dataset.action === 'review') {
        showReviewDetail(report, session, onApproved);
      }
    });
  } catch (e) {
    loading.hidden = true;
    empty.textContent = `Error: ${e.message}`;
    empty.hidden = false;
  }
}

export function closePendingReview(approved = false) {
  const detail = document.getElementById('pending-detail');
  const table = document.getElementById('pending-table');
  if (!detail || detail.hidden) return;
  detail.hidden = true;
  table.hidden = false;
}

function showReviewDetail(report, session, onApproved) {
  const detail = document.getElementById('pending-detail');
  const table = document.getElementById('pending-table');
  const tbody = document.getElementById('pending-tbody');
  if (!detail) return;

  history.pushState({ adminView: 'pending-review' }, '', window.location.href);
  table.hidden = true;
  detail.hidden = false;

  const val = (v) => (v != null && v !== '') ? String(v) : '(not set)';
  const fields = [
    ['Report ID', `#${String(report.id)}`],
    ['Approval Hash', val(report._approval_hash)],
    ['App ID', val(report.app_id)],
    ['Title', val(report.title)],
    ['Source', val(report.source)],
    ['Rating', val(report.rating)],
    ['Proton Version', val(report.proton_version)],
    ['CPU', val(report.cpu)],
    ['GPU', val(report.gpu)],
    ['GPU Driver', val(report.gpu_driver)],
    ['GPU Vendor', val(report.gpu_vendor)],
    ['GPU Architecture', val(report.gpu_architecture)],
    ['RAM', val(report.ram)],
    ['VRAM (MB)', val(report.vram_mb)],
    ['OS', val(report.os)],
    ['Kernel', val(report.kernel)],
    ['Duration', val(report.duration)],
    ['Duration (min)', val(report.duration_minutes)],
    ['Game Owned', val(report.game_owned)],
    ['Config Key', val(report.config_key)],
    ['Notes', val(report.notes)],
    ['Author', report.proton_pulse_user_id || report.client_id || 'anonymous'],
    ['Client ID', val(report.client_id)],
    ['Submitted', report.created_at ? new Date(report.created_at).toLocaleString() : '?'],
    ['Updated', report.updated_at ? new Date(report.updated_at).toLocaleString() : '(not set)'],
  ];

  const formResponsesHtml = report.form_responses
    ? `<tr>
        <td style="font-weight:600;color:var(--muted);width:140px;vertical-align:top">Form Responses</td>
        <td><pre style="margin:0;font-size:0.78rem;white-space:pre-wrap;word-break:break-all">${escapeHtml(JSON.stringify(report.form_responses, null, 2))}</pre></td>
      </tr>`
    : `<tr>
        <td style="font-weight:600;color:var(--muted);width:140px">Form Responses</td>
        <td>(none)</td>
      </tr>`;

  detail.innerHTML = `
    <button class="admin-btn admin-btn--sm" id="pending-back-btn" style="margin-bottom:12px">Back to list</button>
    <div class="admin-card">
      <div class="admin-subhead">Report Review</div>
      <table class="admin-table" style="margin-bottom:16px">
        <tbody>
          ${fields.map(([label, value]) => `
            <tr>
              <td style="font-weight:600;color:var(--muted);width:140px">${escapeHtml(label)}</td>
              <td>${escapeHtml(value)}</td>
            </tr>
          `).join('')}
          ${formResponsesHtml}
        </tbody>
      </table>
      <div style="display:flex;gap:8px">
        <button class="admin-btn admin-btn--ok" id="pending-approve-btn">Approve</button>
        <button class="admin-btn admin-btn--warn" id="pending-decline-btn">Decline</button>
      </div>
      <div id="pending-action-status" style="font-size:0.8rem;margin-top:8px"></div>
    </div>
  `;

  detail.querySelector('#pending-back-btn')?.addEventListener('click', () => {
    closePendingReview();
  });

  const approveBtn = detail.querySelector('#pending-approve-btn');
  const declineBtn = detail.querySelector('#pending-decline-btn');
  const statusEl = detail.querySelector('#pending-action-status');

  approveBtn?.addEventListener('click', async () => {
    approveBtn.disabled = true;
    declineBtn.disabled = true;
    approveBtn.textContent = 'Approving...';
    try {
      await approveReport(session, report);
      document.querySelector(`#pending-tbody tr[data-report-id="${report.id}"]`)?.remove();
      if (tbody && !tbody.children.length) { table.hidden = true; }
      onApproved?.();
      closePendingReview();
    } catch (e) {
      approveBtn.textContent = 'Approve';
      approveBtn.disabled = false;
      declineBtn.disabled = false;
      statusEl.textContent = e.message || 'Approve failed';
      statusEl.style.color = 'var(--red)';
    }
  });

  declineBtn?.addEventListener('click', () => {
    closePendingReview();
  });
}
