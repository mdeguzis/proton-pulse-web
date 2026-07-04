// banned (components) for the admin page.

import { escapeHtml, fmtDateTime } from '../utils.js?v=2668b2f0';

export function renderBanned(rows) {
  const loading = document.getElementById('banned-loading');
  const empty   = document.getElementById('banned-empty');
  const table   = document.getElementById('banned-table');
  const tbody   = document.getElementById('banned-tbody');

  loading.hidden = true;

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const name = escapeHtml(r.steam_username || r.client_id?.slice(0, 8) || 'unknown');
    const reason = escapeHtml(r.banned_reason || '—');
    const bannedAt = escapeHtml(fmtDateTime(r.banned_at));
    const banId = escapeHtml(String(r.id));
    const userId = escapeHtml(r.proton_pulse_user_id || '');
    const clientId = escapeHtml(r.client_id || '');

    return `<tr data-ban-id="${banId}">
      <td>${name}</td>
      <td>${reason}</td>
      <td>${bannedAt}</td>
      <td>
        <button class="admin-btn admin-btn--sm admin-btn--ok" data-action="unban" data-ban-id="${banId}" data-user-id="${userId}" data-client-id="${clientId}">Unban</button>
      </td>
    </tr>`;
  }).join('');
}
