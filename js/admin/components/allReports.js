import { escapeHtml, fmtDateTime } from '../utils.js?v=86489fcb';
import { fetchAllReports } from '../api/allReports.js?v=117740c3';

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
  const dateFromEl = document.getElementById('all-reports-date-from');
  const dateToEl   = document.getElementById('all-reports-date-to');

  loading.hidden = false;
  empty.hidden   = true;
  table.hidden   = true;
  if (countEl) countEl.hidden = true;

  try {
    const q        = searchEl ? searchEl.value.trim() : '';
    const status   = statusEl ? statusEl.value : 'clean';
    const dateFrom = dateFromEl ? dateFromEl.value : '';
    const dateTo   = dateToEl ? dateToEl.value : '';
    const reports = await fetchAllReports(session, { search: q, status, dateFrom, dateTo });

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
      const rid    = escapeHtml(String(r.id));
      const title  = escapeHtml(r.title || '');
      const source = escapeHtml(r.source || '');
      const date   = escapeHtml(fmtDateTime(r.created_at));
      const uid    = r.proton_pulse_user_id || null;
      const cid    = r.client_id || null;
      const userObj = escapeHtml(JSON.stringify({ proton_pulse_user_id: uid, client_id: cid, username: uid || cid || 'anon' }));
      const userBtn = `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="view-user-detail" data-userobj='${userObj}'>Details</button>`;

      return `<tr data-rid="${rid}">
        <td><button class="admin-link-btn" data-action="ar-view-detail" data-rid="${rid}">#${rid}</button></td>
        <td>${appLink}</td>
        <td>${title}</td>
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

export function renderAllReportsDetail(report, { onAction, onBack } = {}) {
  const detail = document.getElementById('report-detail-content');
  if (!detail) return;

  const val = v => (v != null && v !== '') ? escapeHtml(String(v)) : '(not set)';
  const fields = [
    ['Report ID',       `#${report.id}`],
    ['App ID',          val(report.app_id)],
    ['Title',           val(report.title)],
    ['Source',          val(report.source)],
    ['Rating',          val(report.rating)],
    ['Proton Version',  val(report.proton_version)],
    ['CPU',             val(report.cpu)],
    ['GPU',             val(report.gpu)],
    ['GPU Driver',      val(report.gpu_driver)],
    ['GPU Vendor',      val(report.gpu_vendor)],
    ['GPU Architecture',val(report.gpu_architecture)],
    ['RAM',             val(report.ram)],
    ['VRAM (MB)',       val(report.vram_mb)],
    ['OS',              val(report.os)],
    ['Kernel',          val(report.kernel)],
    ['Duration',        val(report.duration)],
    ['Duration (min)',  val(report.duration_minutes)],
    ['Game Owned',      val(report.game_owned)],
    ['Config Key',      val(report.config_key)],
    ['Notes',           val(report.notes)],
    ['Author',          val(report.proton_pulse_user_id || report.client_id || 'anonymous')],
    ['Submitted',       report.created_at ? new Date(report.created_at).toLocaleString() : '?'],
    ['Updated',         report.updated_at ? new Date(report.updated_at).toLocaleString() : '(not set)'],
  ];

  const formResponsesHtml = report.form_responses
    ? `<tr><td style="font-weight:600;color:var(--muted);width:160px;vertical-align:top">Form Responses</td>
        <td><pre style="margin:0;font-size:0.78rem;white-space:pre-wrap;word-break:break-all">${escapeHtml(JSON.stringify(report.form_responses, null, 2))}</pre></td></tr>`
    : `<tr><td style="font-weight:600;color:var(--muted);width:160px">Form Responses</td><td>(none)</td></tr>`;

  const isF = report.is_flagged;
  const isH = report.is_hidden;
  const rid = escapeHtml(String(report.id));
  const actionHtml = (isF || isH)
    ? `<button class="admin-btn admin-btn--ok" data-action="ar-release" data-rid="${rid}">Release</button>`
    : `<button class="admin-btn admin-btn--warn" data-action="ar-flag" data-rid="${rid}">Flag</button>
       <button class="admin-btn admin-btn--danger" data-action="ar-hide" data-rid="${rid}">Hide</button>`;

  detail.innerHTML = `
    <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="ar-back" style="margin-bottom:12px">&#8592; Back to list</button>
    <div class="admin-card">
      <div class="admin-subhead">Report Detail</div>
      <div id="ar-detail-status" style="margin-bottom:10px">${statusBadges(isF, isH)}</div>
      <table class="admin-table" style="margin-bottom:16px">
        <tbody>
          ${fields.map(([label, value]) => `
            <tr>
              <td style="font-weight:600;color:var(--muted);width:160px">${escapeHtml(label)}</td>
              <td>${value}</td>
            </tr>`).join('')}
          ${formResponsesHtml}
        </tbody>
      </table>
      <div id="ar-detail-actions" style="display:flex;gap:8px">${actionHtml}</div>
      <div id="ar-detail-msg" style="font-size:0.8rem;margin-top:8px"></div>
    </div>`;

  detail.querySelector('[data-action="ar-back"]')?.addEventListener('click', () => {
    onBack?.();
  });

  detail.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.dataset.action === 'ar-back') return;
    const action = btn.dataset.action;
    const id     = btn.dataset.rid;
    if (!['ar-flag','ar-hide','ar-release'].includes(action) || !id) return;
    btn.disabled = true;
    onAction?.(action, id, btn);
  });
}
