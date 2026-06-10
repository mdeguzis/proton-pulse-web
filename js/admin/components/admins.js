// admins (components) for the admin page.

import { escapeHtml, fmtDate } from '../utils.js?v=bd5a67c2';

export function renderAdmins(rows) {
  const loading = document.getElementById('admins-loading');
  const empty   = document.getElementById('admins-empty');
  const table   = document.getElementById('admins-table');
  const tbody   = document.getElementById('admins-tbody');

  loading.hidden = true;

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const uid = escapeHtml(r.proton_pulse_user_id);
    const name = escapeHtml(r.steam_username);
    const isSuperAdmin = r.role === 'super_admin';
    const roleSelect = `
      <select class="admin-select admin-select--sm" data-action="change-role" data-uuid="${uid}">
        <option value="moderator" ${r.role === 'moderator' ? 'selected' : ''}>Moderator</option>
        <option value="super_admin" ${isSuperAdmin ? 'selected' : ''}>Super Admin</option>
      </select>`;
    const removeBtn = `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="remove-admin" data-uuid="${uid}" data-name="${name}">Remove</button>`;
    return `<tr>
      <td>${name}</td>
      <td>${roleSelect}</td>
      <td>${escapeHtml(fmtDate(r.added_at))}</td>
      <td>${removeBtn}</td>
    </tr>`;
  }).join('');
}
