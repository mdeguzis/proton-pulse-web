// users (components) for the admin page.

import { escapeHtml, fmtDate, ROLE_LABELS, roleLabel } from '../utils.js?v=86489fcb';

export function renderUsers(rows, { currentUserId, counts, canBan = true } = {}) {
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
    // Identity cell: Steam users are keyed by proton_pulse_user_id, anonymous
    // users by client_id. Always show the relevant id (truncated, full value on
    // hover) so two unnamed users can be told apart -- e.g. for moderation/bans.
    const idType = r.proton_pulse_user_id ? 'steam' : (r.client_id ? 'client' : '');
    const idRaw  = r.proton_pulse_user_id || r.client_id || '';
    const idSafe = escapeHtml(idRaw);
    // Show the full id (no truncation) with a copy button on the right, matching
    // the copy-id control on the user detail screen. The copy value is the raw
    // id without the steam:/client: prefix so it pastes cleanly.
    const identityCell = idRaw
      ? `<span class="admin-id-cell">
          <code class="admin-uid">${escapeHtml(idType)}:${idSafe}</code>
          <button class="admin-btn admin-btn--sm user-detail-copy-btn" type="button"
            data-action="copy-id" data-value="${idSafe}" title="Copy ID to clipboard">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 4H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </span>`
      : '<span class="admin-uid">&mdash;</span>';
    const lastActive = escapeHtml(fmtDate(r.last_active));
    const lastLogin = escapeHtml(fmtDate(r.last_login));
    // Only known roles get a modifier class; everyone else is the neutral "User" badge.
    const roleMod = ROLE_LABELS[r.role] ? ` admin-role-badge--${r.role}` : '';
    const roleCell = `<span class="admin-role-badge${roleMod}">${escapeHtml(roleLabel(r.role))}</span>`;
    const isSelf = currentUserId && r.proton_pulse_user_id === currentUserId;
    let banBtn;
    if (!canBan) {
      banBtn = ''; // admin lacks ban_users; RLS would reject anyway
    } else if (isSelf) {
      banBtn = `<button class="admin-btn admin-btn--danger admin-btn--sm" disabled title="Cannot ban yourself">Ban</button>`;
    } else if (r.is_banned) {
      banBtn = `<button class="admin-btn admin-btn--ok admin-btn--sm" data-action="unban-user"
        data-ban-id="${escapeHtml(String(r.ban_id || ''))}"
        data-userid="${uid}" data-clientid="${cid}">Unban</button>`;
    } else {
      banBtn = `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="ban-user" data-userid="${uid}" data-clientid="${cid}" data-username="${name}">Ban</button>`;
    }
    // Details button: navigates to the full user detail screen.
    const userObj = escapeHtml(JSON.stringify({
      proton_pulse_user_id: r.proton_pulse_user_id,
      client_id: r.client_id,
      display_name: r.display_name,
      role: r.role,
      last_login: r.last_login,
      last_active: r.last_active,
      report_count: r.report_count,
      is_banned: r.is_banned || false,
      ban_id: r.ban_id || null,
    }));
    const detailsBtn = `<button class="admin-btn admin-btn--sm admin-btn--details" type="button"
      data-action="view-user-detail"
      data-userid="${uid}"
      data-clientid="${cid}"
      data-username="${name}"
      data-userobj='${userObj}'>Details</button>`;
    const bannedBadge = r.is_banned ? ' <span class="user-detail-flag user-detail-flag--danger">banned</span>' : '';
    return `<tr${r.is_banned ? ' class="admin-row--banned"' : ''}>
      <td>${name}${bannedBadge}</td>
      <td>${identityCell}</td>
      <td>${roleCell}</td>
      <td>${r.report_count}</td>
      <td>${lastActive}</td>
      <td>${lastLogin || '—'}</td>
      <td class="admin-col-actions">${detailsBtn}${banBtn}</td>
    </tr>`;
  }).join('');
}
