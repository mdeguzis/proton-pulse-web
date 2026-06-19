// flagged (components) for the admin page.

import { escapeHtml, fmtDateTime, friendlyReason } from '../utils.js?v=86489fcb';

const STATUS_LABELS = { open: 'Open', in_review: 'In Review', complete: 'Complete' };

// Pulse reports live in user_configs and can be moderated directly. ProtonDB
// reports come from the static mirror, so only their flag entry is actionable.
export function isPulseSource(source) {
  const s = String(source || '').toLowerCase();
  return s === 'pulse' || s === 'proton-pulse';
}

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
      <td><span class="admin-sub">${escapeHtml(fmtDateTime(r.flagged_at))}</span></td>
      <td><span class="admin-sub">${status === 'open' ? '—' : escapeHtml(fmtDateTime(r.updated_at))}</span></td>
      <td><span class="admin-status admin-status--${escapeHtml(status)}">${statusLabel}</span></td>
      <td>
        <button class="admin-btn admin-btn--sm" data-action="review-flag" data-id="${rowId}">Review</button>
      </td>
    </tr>`;
  }).join('');
}

function _renderRawFields(obj, title) {
  const rows = Object.entries(obj).map(([k, v]) => {
    let display;
    if (v === null || v === undefined) {
      display = '<span class="admin-sub">(null)</span>';
    } else if (typeof v === 'object') {
      display = `<pre class="flag-raw-json">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
    } else {
      display = escapeHtml(String(v));
    }
    return `<tr><td class="flag-raw-key">${escapeHtml(k)}</td><td class="flag-raw-val">${display}</td></tr>`;
  }).join('');
  return `<div class="flag-raw-section">
    <div class="flag-raw-title">${escapeHtml(title)}</div>
    <table class="flag-raw-table"><tbody>${rows}</tbody></table>
  </div>`;
}

export function renderFlagDetail(flagRow, reportContent, modState) {
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

  // Current moderation state drives the toggle: when a report is shadow-banned,
  // the Shadow ban button becomes Un-shadow ban (which releases it).
  const state = (modState && modState.state) || 'visible';
  const STATE_LABEL = { visible: 'Visible', shadowbanned: 'Shadow banned', deleted: 'Deleted' };
  const isShadowed = state === 'shadowbanned';
  const shadowBtn = isShadowed
    ? `<button class="admin-btn admin-btn--ok flag-action-active" data-action="flag-release" data-id="${rowId}" title="Make this report visible again">Un-shadow ban</button>`
    : `<button class="admin-btn admin-btn--warn" data-action="flag-shadowban" data-id="${rowId}" title="Hide from everyone except the submitter">Shadow ban</button>`;

  // One action bar at the top. Actions apply to ANY source: Pulse reports are
  // edited/deleted in our DB, ProtonDB mirror reports are suppressed via
  // report_moderation and filtered out on the site. Our site, our rules.
  const actionBar = `
    <div class="flag-detail-actions">
      <span class="flag-detail-state">State: <strong class="flag-state--${state}">${STATE_LABEL[state] || state}</strong></span>
      <button class="admin-btn admin-btn--ok" data-action="flag-release" data-id="${rowId}" title="Keep this report; clear its flagged/hidden state">Release</button>
      ${shadowBtn}
      <button class="admin-btn admin-btn--danger" data-action="flag-delete-report" data-id="${rowId}" title="Remove this report from the site">Delete report</button>
      <span class="flag-detail-actions-sep"></span>
      <button class="admin-btn admin-btn--sm" data-action="flag-set-status" data-status="in_review" data-id="${rowId}">In Review</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="flag-delete" data-id="${rowId}" title="Remove just this flag log entry">Delete flag entry</button>
    </div>`;

  const sourceNote = isPulseSource(flagRow.source)
    ? ''
    : '<div class="admin-sub" style="margin:6px 0 0;font-style:italic">ProtonDB report: Shadow ban and Delete remove it from our site. The upstream mirror is unchanged; Release un-hides it.</div>';

  return `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="back-to-flagged" style="margin-bottom:16px">&#8592; Back</button>

    ${actionBar}
    ${sourceNote}

    <div class="flag-detail-reason">
      <div class="flag-detail-reason-label">Flag reason</div>
      <div class="flag-detail-reason-value">${reason}</div>
      ${noteText ? `<div class="flag-detail-reason-note">${noteText}</div>` : ''}
    </div>

    <div class="flag-detail-meta">
      <div><span class="admin-label-text">Game</span>
        <a href="${escapeHtml(appLink)}" target="_blank" rel="noopener" class="admin-link">${name}</a>
        <span class="admin-sub"> (App ${escapeHtml(String(flagRow.app_id))})</span></div>
      <div><span class="admin-label-text">Source</span> ${source}</div>
      <div><span class="admin-label-text">Reporter</span> <span class="admin-sub">${reporter}</span></div>
      <div><span class="admin-label-text">Flagged</span> ${flaggedAt}</div>
      <div><span class="admin-label-text">Reviewed</span> ${status === 'open' ? '<span class="admin-sub">not yet</span>' : escapeHtml(fmtDateTime(flagRow.updated_at))}</div>
      <div><span class="admin-label-text">Status</span>
        <span class="admin-status admin-status--${escapeHtml(status)}" id="flag-detail-status">${statusLabel}</span></div>
    </div>

    ${_renderRawFields(flagRow, 'Flag record (flagged_reports)')}
    ${reportContent
      ? _renderRawFields(reportContent, 'Linked report content')
      : '<div class="admin-sub" style="margin-bottom:20px;font-style:italic">Linked report content not available (report_key may not match any stored report).</div>'}`;
}
