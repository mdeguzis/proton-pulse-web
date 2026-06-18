// flagged (components) for the admin page.

import { escapeHtml, fmtDateTime, friendlyReason } from '../utils.js?v=86489fcb';

const STATUS_LABELS = { open: 'Open', in_review: 'In Review', complete: 'Complete' };

const RATING_COLORS = {
  platinum: '#b9f2ff',
  gold:     '#ffd700',
  silver:   '#c0c0c0',
  bronze:   '#cd7f32',
  borked:   '#e06c75',
};

export function renderFlagged(rows) {
  const loading = document.getElementById('flagged-loading');
  const empty   = document.getElementById('flagged-empty');
  const table   = document.getElementById('flagged-table');
  const tbody   = document.getElementById('flagged-tbody');

  loading.hidden = true;

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const appLink = `app.html#/app/${encodeURIComponent(r.app_id)}`;
    const name    = escapeHtml(r.title || `App ${r.app_id}`);
    const source  = escapeHtml(r.source || 'unknown');
    const status  = r.status || 'open';
    const statusLabel = escapeHtml(STATUS_LABELS[status] || status);
    const rowId   = escapeHtml(String(r.id));

    return `<tr data-id="${rowId}">
      <td><a href="${escapeHtml(appLink)}" target="_blank" rel="noopener" class="admin-link">${name}</a>
          <div class="admin-sub">App ${escapeHtml(String(r.app_id))}</div></td>
      <td>${source}</td>
      <td><span class="admin-status admin-status--${escapeHtml(status)}">${statusLabel}</span></td>
      <td>
        <button class="admin-btn admin-btn--sm" data-action="review-flag" data-id="${rowId}">Review</button>
      </td>
    </tr>`;
  }).join('');
}

function _renderReportCard(r) {
  if (!r) return '';
  const rating      = (r.rating || '').toLowerCase();
  const ratingColor = RATING_COLORS[rating] || '#888';
  const ratingLabel = escapeHtml(rating || '?');
  const proton      = escapeHtml(r.protonVersion || r.proton_version || '');
  const gpu         = escapeHtml(r.gpu || '');
  const cpu         = escapeHtml(r.cpu || '');
  const os          = escapeHtml(r.os || '');
  const notes       = escapeHtml(r.notes || '');
  const source      = escapeHtml(r.source || '');
  const ts          = r.timestamp ? new Date(r.timestamp * 1000).toLocaleDateString() : '';

  const hw = [gpu, cpu, os].filter(Boolean).join(' &middot; ');

  return `<div class="flag-report-card">
    <div class="flag-report-card-header">
      <span class="flag-report-rating" style="color:${ratingColor}">${ratingLabel}</span>
      ${proton ? `<span class="flag-report-proton">${proton}</span>` : ''}
      <span class="flag-report-source">${source}</span>
      ${ts ? `<span class="flag-report-date admin-sub">${escapeHtml(ts)}</span>` : ''}
    </div>
    ${hw ? `<div class="flag-report-hw admin-sub">${hw}</div>` : ''}
    ${notes ? `<div class="flag-report-notes">${notes}</div>` : '<div class="admin-sub flag-report-notes--empty">(no notes)</div>'}
  </div>`;
}

export function renderFlagDetail(flagRow, reportContent) {
  const appLink    = `app.html#/app/${encodeURIComponent(flagRow.app_id)}`;
  const name       = escapeHtml(flagRow.title || `App ${flagRow.app_id}`);
  const source     = escapeHtml(flagRow.source || 'unknown');
  const reason     = escapeHtml(friendlyReason(flagRow.reason_category || flagRow.flagged_reason));
  const noteText   = flagRow.reason_text ? escapeHtml(flagRow.reason_text) : '';
  const reporter   = escapeHtml((flagRow.reporter_client_id || '').slice(0, 20) || 'anonymous');
  const flaggedAt  = escapeHtml(fmtDateTime(flagRow.flagged_at));
  const status     = flagRow.status || 'open';
  const statusLabel = escapeHtml(STATUS_LABELS[status] || status);
  const rowId      = escapeHtml(String(flagRow.id));

  return `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="back-to-flagged" style="margin-bottom:16px">&#8592; Back</button>

    <div class="flag-detail-reason">
      <div class="flag-detail-reason-label">Flag reason</div>
      <div class="flag-detail-reason-value">${reason}</div>
      ${noteText ? `<div class="flag-detail-reason-note">${noteText}</div>` : ''}
    </div>

    ${_renderReportCard(reportContent)}

    <div class="flag-detail-meta">
      <div><span class="admin-label-text">Game</span>
        <a href="${escapeHtml(appLink)}" target="_blank" rel="noopener" class="admin-link">${name}</a>
        <span class="admin-sub"> (App ${escapeHtml(String(flagRow.app_id))})</span></div>
      <div><span class="admin-label-text">Source</span> ${source}</div>
      <div><span class="admin-label-text">Reporter</span> <span class="admin-sub">${reporter}</span></div>
      <div><span class="admin-label-text">Flagged</span> ${flaggedAt}</div>
      <div><span class="admin-label-text">Status</span>
        <span class="admin-status admin-status--${escapeHtml(status)}" id="flag-detail-status">${statusLabel}</span></div>
    </div>

    <div class="flag-detail-actions">
      <button class="admin-btn admin-btn--ok" data-action="flag-set-status" data-status="open" data-id="${rowId}">Dismiss</button>
      <button class="admin-btn admin-btn--warn" data-action="flag-set-status" data-status="in_review" data-id="${rowId}">In Review</button>
      <button class="admin-btn" data-action="flag-set-status" data-status="complete" data-id="${rowId}">Complete</button>
      <button class="admin-btn admin-btn--danger" data-action="flag-delete" data-id="${rowId}">Delete</button>
    </div>`;
}
