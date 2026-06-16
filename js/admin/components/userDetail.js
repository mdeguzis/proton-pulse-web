// userDetail (component) for the admin page - renders the full user detail screen.

import { escapeHtml, fmtDate, ROLE_LABELS, roleLabel } from '../utils.js?v=86489fcb';

function idRow(label, value) {
  if (!value) {
    return `<div class="user-detail-id-row">
      <span class="user-detail-label">${label}</span>
      <span class="user-detail-id-empty">&#8212;</span>
    </div>`;
  }
  const safe = escapeHtml(value);
  return `<div class="user-detail-id-row">
    <span class="user-detail-label">${label}</span>
    <code class="admin-uid">${safe}</code>
    <button class="admin-btn admin-btn--sm user-detail-copy-btn" type="button"
      data-action="copy-id" data-value="${safe}" title="Copy">Copy</button>
  </div>`;
}

function memberSince(reports) {
  if (!reports.length) return '&#8212;';
  const earliest = reports.reduce((a, b) => (a.created_at < b.created_at ? a : b));
  return escapeHtml(fmtDate(earliest.created_at));
}

function renderReportsTable(reports) {
  if (!reports.length) {
    return `<p class="admin-empty" style="padding:8px 0">No reports submitted yet.</p>`;
  }
  const rows = reports.map(r => {
    const title      = escapeHtml(r.title || r.app_id || '—');
    const rating     = escapeHtml(r.rating || '—');
    const proton     = escapeHtml(r.proton_version || '—');
    const date       = escapeHtml(fmtDate(r.created_at));
    const source     = escapeHtml(r.source || '—');
    const hidden     = r.is_hidden  ? '<span class="user-detail-flag user-detail-flag--warn">hidden</span>'  : '';
    const flagged    = r.is_flagged ? '<span class="user-detail-flag user-detail-flag--danger">flagged</span>' : '';
    const appId      = escapeHtml(String(r.app_id || ''));
    const gameLink   = r.app_id
      ? `<a class="admin-link" href="/app.html#/app/${appId}" target="_blank">${title}</a>`
      : title;
    return `<tr>
      <td>${gameLink}</td>
      <td>${rating}</td>
      <td>${proton}</td>
      <td>${date}</td>
      <td>${source}</td>
      <td>${hidden}${flagged}</td>
    </tr>`;
  }).join('');
  return `<table class="admin-table user-detail-table">
    <thead><tr>
      <th>Game</th>
      <th>Rating</th>
      <th>Proton</th>
      <th>Date</th>
      <th>Source</th>
      <th>Flags</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderUserDetail(user, reports, { onBack, onBan, currentUserId } = {}) {
  const name       = escapeHtml(user.display_name || '(anonymous)');
  const roleMod    = ROLE_LABELS[user.role] ? ` admin-role-badge--${user.role}` : '';
  const rolePill   = `<span class="admin-role-badge${roleMod}">${escapeHtml(roleLabel(user.role))}</span>`;
  const isSelf     = currentUserId && user.proton_pulse_user_id === currentUserId;
  const banBtn     = isSelf
    ? `<button class="admin-btn admin-btn--danger admin-btn--sm" disabled title="Cannot ban yourself">Ban</button>`
    : `<button class="admin-btn admin-btn--danger admin-btn--sm"
        data-action="ban-from-detail"
        data-userid="${escapeHtml(user.proton_pulse_user_id || '')}"
        data-clientid="${escapeHtml(user.client_id || '')}"
        data-username="${name}">Ban</button>`;

  const since = memberSince(reports);

  const el = document.getElementById('user-detail-content');
  el.innerHTML = `
    <div class="user-detail-back">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" data-action="back-to-users">&#8592; Back to users</button>
    </div>

    <div class="user-detail-header">
      <span class="user-detail-name">${name}</span>
      ${rolePill}
      <div class="user-detail-header-actions">${banBtn}</div>
    </div>

    <div class="user-detail-section">
      <div class="user-detail-section-title">IDs</div>
      ${idRow('User ID', user.proton_pulse_user_id)}
      ${idRow('Plugin Client ID', user.client_id)}
    </div>

    <div class="user-detail-section">
      <div class="user-detail-section-title">Timeline</div>
      <div class="user-detail-timeline">
        <div class="user-detail-tl-row">
          <span class="user-detail-label">Last login</span>
          <span>${escapeHtml(fmtDate(user.last_login))}</span>
        </div>
        <div class="user-detail-tl-row">
          <span class="user-detail-label">Last active</span>
          <span>${escapeHtml(fmtDate(user.last_active))}</span>
        </div>
        <div class="user-detail-tl-row">
          <span class="user-detail-label">Member since</span>
          <span>${since}</span>
        </div>
      </div>
    </div>

    <div class="user-detail-section">
      <div class="user-detail-section-title">Activity <span class="user-detail-count">(${reports.length} report${reports.length !== 1 ? 's' : ''})</span></div>
      ${renderReportsTable(reports)}
    </div>
  `;

  // Wire copy buttons inside the rendered content.
  el.querySelectorAll('[data-action="copy-id"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      navigator.clipboard.writeText(val).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      }).catch(() => {});
    });
  });
}
