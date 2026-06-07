// flagged (components) for the admin page.

import { escapeHtml, fmtDateTime, friendlyReason } from '../utils.js';

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
    const name = escapeHtml(r.title || `App ${r.app_id}`);
    const author = r._author?.display_name || r._author?.steam_id || r.proton_pulse_user_id?.slice(0, 8) || r.client_id?.slice(0, 8) || 'anon';
    const reason = escapeHtml(friendlyReason(r.flagged_reason));
    const flaggedAt = escapeHtml(fmtDateTime(r.flagged_at));
    const rowId = escapeHtml(String(r.id));
    const userId = escapeHtml(r.proton_pulse_user_id || '');
    const clientId = escapeHtml(r.client_id || '');
    const authorName = escapeHtml(r._author?.display_name || author);

    return `<tr data-id="${rowId}">
      <td><a href="${escapeHtml(appLink)}" target="_blank" rel="noopener" class="admin-link">${name}</a>
          <div class="admin-sub">App ${escapeHtml(String(r.app_id))}</div></td>
      <td>${escapeHtml(author)}</td>
      <td><span class="admin-reason">${reason}</span></td>
      <td>${flaggedAt}</td>
      <td>
        <div class="admin-actions">
          <button class="admin-btn admin-btn--sm admin-btn--ok" data-action="reinstate" data-id="${rowId}">Reinstate</button>
          <button class="admin-btn admin-btn--sm admin-btn--danger" data-action="delete" data-id="${rowId}">Delete</button>
          <button class="admin-btn admin-btn--sm admin-btn--warn" data-action="ban" data-id="${rowId}" data-user-id="${userId}" data-client-id="${clientId}" data-username="${authorName}">Ban User</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}
