// users (components) for the admin page.

import { escapeHtml, fmtDate, ROLE_LABELS, roleLabel } from '../utils.js';

export function renderUsers(rows, { currentUserId, counts } = {}) {
  const loading = document.getElementById('users-loading');
  const empty   = document.getElementById('users-empty');
  const table   = document.getElementById('users-table');
  const tbody   = document.getElementById('users-tbody');
  const err     = document.getElementById('users-error');
  const countsEl = document.getElementById('users-counts');

  loading.hidden = true;
  err.hidden = true;

  // Counts reflect the full user set, independent of the current search filter.
  if (countsEl && counts) {
    countsEl.innerHTML =
      `<span class="admin-count"><strong>${counts.total.toLocaleString()}</strong> total</span>` +
      `<span class="admin-count"><strong>${counts.steam.toLocaleString()}</strong> Steam</span>` +
      `<span class="admin-count"><strong>${counts.anon.toLocaleString()}</strong> anonymous</span>`;
    countsEl.hidden = false;
  }

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const uid = escapeHtml(r.proton_pulse_user_id || '');
    const cid = escapeHtml(r.client_id || '');
    const name = escapeHtml(r.display_name || '(anonymous)');
    const lastActive = escapeHtml(fmtDate(r.last_active));
    // Only known roles get a modifier class; everyone else is the neutral "User" badge.
    const roleMod = ROLE_LABELS[r.role] ? ` admin-role-badge--${r.role}` : '';
    const roleCell = `<span class="admin-role-badge${roleMod}">${escapeHtml(roleLabel(r.role))}</span>`;
    const isSelf = currentUserId && r.proton_pulse_user_id === currentUserId;
    const banBtn = isSelf
      ? `<button class="admin-btn admin-btn--danger admin-btn--sm" disabled title="Cannot ban yourself">Ban</button>`
      : `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="ban-user" data-userid="${uid}" data-username="${name}">Ban</button>`;
    return `<tr>
      <td>${name}</td>
      <td>${roleCell}</td>
      <td><code class="admin-uid">${uid || '—'}</code></td>
      <td><code class="admin-uid">${cid || '—'}</code></td>
      <td>${r.report_count}</td>
      <td>${lastActive}</td>
      <td>${banBtn}</td>
    </tr>`;
  }).join('');
}
