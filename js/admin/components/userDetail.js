// userDetail (component) for the admin page - renders the full user detail screen.

import { escapeHtml, fmtDate, fmtDateTime, ROLE_LABELS, roleLabel } from '../utils.js?v=86489fcb';
import { deleteUserReport, hideUserReport, editUserReport } from '../api/userDetail.js?v=916aedfc';

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
      data-action="copy-id" data-value="${safe}" title="Copy to clipboard">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M3 4H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
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
    const id         = escapeHtml(String(r.id));
    const title      = escapeHtml(r.title || r.app_id || '—');
    const rating     = escapeHtml(r.rating || '—');
    const proton     = escapeHtml(r.proton_version || '—');
    const date       = escapeHtml(fmtDateTime(r.created_at));
    const source     = escapeHtml(r.source || '—');
    const hiddenFlag = r.is_hidden  ? '<span class="user-detail-flag user-detail-flag--warn">hidden</span>'  : '';
    const flagged    = r.is_flagged ? '<span class="user-detail-flag user-detail-flag--danger">flagged</span>' : '';
    const appId      = escapeHtml(String(r.app_id || ''));
    const gameLink   = r.app_id
      ? `<a class="admin-link" href="/app.html#/app/${appId}" target="_blank">${title}</a>`
      : title;
    const hideLabel  = r.is_hidden ? 'Restore' : 'Hide';
    const hideClass  = r.is_hidden ? 'admin-btn--ok' : 'admin-btn--warn';
    return `<tr data-report-id="${id}">
      <td>${gameLink}</td>
      <td>${rating}</td>
      <td>${proton}</td>
      <td>${date}</td>
      <td>${source}</td>
      <td>${hiddenFlag}${flagged}</td>
      <td class="admin-col-actions">
        <button class="admin-btn admin-btn--sm" data-action="edit-report" data-id="${id}"
          data-rating="${escapeHtml(r.rating||'')}" data-proton="${escapeHtml(r.proton_version||'')}"
          data-launch="${escapeHtml(r.launch_options||'')}" data-notes="${escapeHtml(r.notes||'')}">Edit</button>
        <button class="admin-btn admin-btn--sm ${hideClass}" data-action="hide-report" data-id="${id}" data-hidden="${r.is_hidden ? '1' : '0'}">${hideLabel}</button>
        <button class="admin-btn admin-btn--sm admin-btn--danger" data-action="delete-report" data-id="${id}">Delete</button>
      </td>
    </tr>`;
  }).join('');
  return `<table class="admin-table user-detail-table">
    <thead><tr>
      <th>Game</th><th>Rating</th><th>Proton</th><th>Date</th><th>Source</th><th>Flags</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function metaSummary(metadata) {
  if (!metadata) return '';
  const parts = [];
  if (metadata.reason)   parts.push(escapeHtml(metadata.reason));
  if (metadata.steam_id) parts.push(`steam:${escapeHtml(metadata.steam_id)}`);
  return parts.join(', ');
}

function buildActivityTable(events) {
  if (!events.length) return '<p class="admin-empty" style="padding:8px 0">No activity recorded yet.</p>';
  const rows = events.map(ev =>
    `<tr>
      <td style="white-space:nowrap">${escapeHtml(fmtDateTime(ev.created_at))}</td>
      <td><code style="font-size:0.78rem">${escapeHtml(ev.event_type)}</code></td>
      <td>${escapeHtml(ev.page || '')}</td>
      <td style="color:var(--text-muted,#888);font-size:0.8rem">${metaSummary(ev.metadata)}</td>
    </tr>`
  ).join('');
  return `<table class="admin-table user-detail-table">
    <thead><tr><th>Date/Time</th><th>Event</th><th>Page</th><th>Details</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderActivitySection(el, allActivity, filter) {
  const filtered = filter ? allActivity.filter(e => e.event_type === filter) : allActivity;
  el.querySelector('#ud-activity-table').innerHTML = buildActivityTable(filtered);
  el.querySelector('#ud-activity-count').textContent = `(${filtered.length})`;
}

export function renderUserDetail(user, reports, authEvents, { session, onBack, onBan, currentUserId } = {}) {
  const name       = escapeHtml(user.display_name || '(anonymous)');
  const roleMod    = ROLE_LABELS[user.role] ? ` admin-role-badge--${user.role}` : '';
  const rolePill   = `<span class="admin-role-badge${roleMod}">${escapeHtml(roleLabel(user.role))}</span>`;
  const isSelf     = currentUserId && user.proton_pulse_user_id === currentUserId;
  let banBtn;
  if (isSelf) {
    banBtn = `<button class="admin-btn admin-btn--danger admin-btn--sm" disabled title="Cannot ban yourself">Ban</button>`;
  } else if (user.is_banned) {
    banBtn = `<button class="admin-btn admin-btn--ok admin-btn--sm"
      data-action="unban-from-detail"
      data-ban-id="${escapeHtml(String(user.ban_id || ''))}"
      data-userid="${escapeHtml(user.proton_pulse_user_id || '')}"
      data-clientid="${escapeHtml(user.client_id || '')}">Unban</button>`;
  } else {
    banBtn = `<button class="admin-btn admin-btn--danger admin-btn--sm"
      data-action="ban-from-detail"
      data-userid="${escapeHtml(user.proton_pulse_user_id || '')}"
      data-clientid="${escapeHtml(user.client_id || '')}"
      data-username="${name}">Ban</button>`;
  }
  const statusBadge = user.is_banned
    ? `<span class="user-detail-flag user-detail-flag--danger" style="font-size:0.8rem">Banned</span>`
    : `<span class="user-detail-flag user-detail-flag--ok" style="font-size:0.8rem">Active</span>`;
  const exportBtn  = `<button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" data-action="export-user-json">Export JSON</button>`;

  const since = memberSince(reports);

  const el = document.getElementById('user-detail-content');
  el.innerHTML = `
    <div class="user-detail-back">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" data-action="back-to-users">&#8592; Back to users</button>
    </div>

    <div class="user-detail-header">
      <span class="user-detail-name">${name}</span>
      ${rolePill}
      ${statusBadge}
      <div class="user-detail-header-actions">${exportBtn}${banBtn}</div>
    </div>

    <div class="user-detail-section">
      <div class="user-detail-section-title">IDs</div>
      ${idRow('User ID', user.proton_pulse_user_id)}
      ${idRow('Plugin ID', user.client_id)}
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
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span class="user-detail-section-title" style="margin:0">Audit log</span>
        <span class="user-detail-count" id="ud-activity-count">(${authEvents.length})</span>
        <select id="ud-activity-filter" class="admin-select admin-select--sm">
          <option value="">All types</option>
          ${[...new Set(authEvents.map(e => e.event_type))].map(t =>
            `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`
          ).join('')}
        </select>
      </div>
      <div id="ud-activity-table">${buildActivityTable(authEvents)}</div>
    </div>

    <div class="user-detail-section">
      <div class="user-detail-section-title">Reports <span class="user-detail-count">(${reports.length})</span></div>
      <div id="ud-reports-wrap">${renderReportsTable(reports)}</div>
    </div>

    <div id="ud-edit-modal" class="admin-modal-backdrop" hidden>
      <div class="admin-modal">
        <div class="admin-modal-title">Edit report</div>
        <label class="admin-label">Rating
          <select id="ud-edit-rating" class="admin-select">
            <option value="platinum">Platinum</option>
            <option value="gold">Gold</option>
            <option value="silver">Silver</option>
            <option value="bronze">Bronze</option>
            <option value="borked">Borked</option>
          </select>
        </label>
        <label class="admin-label">Proton version
          <input id="ud-edit-proton" class="admin-input" type="text">
        </label>
        <label class="admin-label">Launch options
          <input id="ud-edit-launch" class="admin-input" type="text">
        </label>
        <label class="admin-label">Notes
          <textarea id="ud-edit-notes" class="admin-input" rows="3" style="resize:vertical"></textarea>
        </label>
        <div class="admin-modal-actions">
          <button class="admin-btn" id="ud-edit-save">Save</button>
          <button class="admin-btn admin-btn--ghost" id="ud-edit-cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Wire copy buttons inside the rendered content.
  el.querySelectorAll('[data-action="copy-id"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      navigator.clipboard.writeText(val).then(() => {
        const tip = document.createElement('span');
        tip.className = 'copy-tooltip';
        tip.textContent = 'Copied';
        btn.appendChild(tip);
        requestAnimationFrame(() => tip.classList.add('copy-tooltip--show'));
        setTimeout(() => tip.remove(), 1000);
      }).catch(() => {});
    });
  });

  // Report actions (delegated on the reports wrap).
  let editingId = null;
  const reportsWrap = el.querySelector('#ud-reports-wrap');
  const editModal   = el.querySelector('#ud-edit-modal');

  reportsWrap?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'delete-report') {
      if (!confirm('Delete this report permanently?')) return;
      btn.disabled = true;
      try {
        await deleteUserReport(session, id);
        btn.closest('tr').remove();
        const remaining = reportsWrap.querySelectorAll('tbody tr').length;
        el.querySelector('.user-detail-section:last-of-type .user-detail-count').textContent = `(${remaining})`;
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    }

    if (action === 'hide-report') {
      const hide = btn.dataset.hidden !== '1';
      btn.disabled = true;
      try {
        await hideUserReport(session, id, hide);
        btn.dataset.hidden = hide ? '1' : '0';
        btn.textContent = hide ? 'Restore' : 'Hide';
        btn.className = `admin-btn admin-btn--sm ${hide ? 'admin-btn--ok' : 'admin-btn--warn'}`;
        const flagCell = btn.closest('tr').querySelector('td:nth-child(6)');
        if (flagCell) {
          const existing = flagCell.querySelector('.user-detail-flag--warn');
          if (hide && !existing) {
            flagCell.insertAdjacentHTML('afterbegin', '<span class="user-detail-flag user-detail-flag--warn">hidden</span>');
          } else if (!hide && existing) {
            existing.remove();
          }
        }
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    }

    if (action === 'edit-report') {
      editingId = id;
      el.querySelector('#ud-edit-rating').value  = btn.dataset.rating  || 'platinum';
      el.querySelector('#ud-edit-proton').value  = btn.dataset.proton  || '';
      el.querySelector('#ud-edit-launch').value  = btn.dataset.launch  || '';
      el.querySelector('#ud-edit-notes').value   = btn.dataset.notes   || '';
      editModal.hidden = false;
    }
  });

  el.querySelector('#ud-edit-cancel')?.addEventListener('click', () => {
    editModal.hidden = true;
    editingId = null;
  });
  editModal?.addEventListener('click', e => { if (e.target === editModal) { editModal.hidden = true; editingId = null; } });

  el.querySelector('#ud-edit-save')?.addEventListener('click', async () => {
    if (!editingId) return;
    const saveBtn = el.querySelector('#ud-edit-save');
    saveBtn.disabled = true;
    const fields = {
      rating:          el.querySelector('#ud-edit-rating').value,
      proton_version:  el.querySelector('#ud-edit-proton').value.trim(),
      launch_options:  el.querySelector('#ud-edit-launch').value.trim(),
      notes:           el.querySelector('#ud-edit-notes').value.trim(),
    };
    try {
      await editUserReport(session, editingId, fields);
      // Update the edit button's data attrs so re-opening shows current values.
      const editBtn = reportsWrap.querySelector(`[data-action="edit-report"][data-id="${editingId}"]`);
      if (editBtn) {
        editBtn.dataset.rating  = fields.rating;
        editBtn.dataset.proton  = fields.proton_version;
        editBtn.dataset.launch  = fields.launch_options;
        editBtn.dataset.notes   = fields.notes;
        const row = editBtn.closest('tr');
        if (row) {
          row.querySelector('td:nth-child(2)').textContent = fields.rating;
          row.querySelector('td:nth-child(3)').textContent = fields.proton_version;
        }
      }
      editModal.hidden = true;
      editingId = null;
    } catch (err) {
      alert(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Activity filter dropdown.
  el.querySelector('#ud-activity-filter')?.addEventListener('change', e => {
    renderActivitySection(el, authEvents, e.target.value);
  });

  // Export JSON download.
  el.querySelector('[data-action="export-user-json"]')?.addEventListener('click', () => {
    const payload = {
      exported_at: new Date().toISOString(),
      user: {
        proton_pulse_user_id: user.proton_pulse_user_id || null,
        client_id: user.client_id || null,
        display_name: user.display_name || null,
        role: user.role || null,
        last_login: user.last_login || null,
        last_active: user.last_active || null,
      },
      reports,
      auth_events: authEvents || [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safeName = (user.display_name || user.proton_pulse_user_id || 'user').replace(/[^a-z0-9_-]/gi, '_');
    a.download = `user-${safeName}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
