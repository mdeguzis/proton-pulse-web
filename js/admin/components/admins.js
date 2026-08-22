// admins (components) for the admin page.

import { escapeHtml, fmtDateTime } from '../utils.js?v=2668b2f0';
import { PERMISSION_LABELS, effectivePermissions, resolveRoleLabel, permissionsToAdd } from '../permissions.js?v=7b4e356d';

// Role <select> for a row or the add form. `uuid` is 'new' for the add form.
function roleSelectHtml(label, uuid) {
  const opt = (v, text) => `<option value="${v}"${label === v ? ' selected' : ''}>${text}</option>`;
  return `<select class="admin-select admin-select--sm" data-action="change-role" data-uuid="${uuid}">
    ${opt('moderator', 'Moderator')}
    ${opt('super_admin', 'Super Admin')}
    ${opt('custom', 'Custom')}
  </select>`;
}

// Granular permission editor: removable chips + an "add permission" dropdown.
// super_admin always has everything, so its editor is a read-only label.
// `uuid` is 'new' for the add form so the handler edits draft state instead of
// persisting.
export function permEditorHtml(role, perms, uuid) {
  if (role === 'super_admin') {
    return '<span class="admin-perms-caps">All permissions</span>';
  }
  const eff = effectivePermissions(role, perms);
  const chips = eff.map(k => {
    const label = escapeHtml(PERMISSION_LABELS[k] || k);
    return `<span class="perm-chip">${label}<button type="button" class="perm-chip-x" ` +
      `data-action="remove-perm" data-uuid="${uuid}" data-perm="${k}" ` +
      `title="Remove" aria-label="Remove ${label}">&times;</button></span>`;
  }).join('');
  const toAdd = permissionsToAdd(eff);
  const addSel = toAdd.length
    ? `<select class="admin-select admin-select--sm perm-add" data-action="add-perm" data-uuid="${uuid}">` +
      `<option value="">+ add permission</option>` +
      toAdd.map(k => `<option value="${k}">${escapeHtml(PERMISSION_LABELS[k] || k)}</option>`).join('') +
      `</select>`
    : '';
  return `<div class="perm-editor">${chips || '<span class="admin-perms-caps">none</span>'}${addSel}</div>`;
}

// Render the add-form permission editor from the current draft state.
export function renderNewAdminEditor(role, perms) {
  const el = document.getElementById('new-admin-perms');
  if (el) el.innerHTML = permEditorHtml(role, perms, 'new');
}

export function renderAdmins(rows, { currentUserId } = {}) {
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
    const label = resolveRoleLabel(r.role, r.permissions);
    const eff = effectivePermissions(r.role, r.permissions);
    const isSelf = currentUserId && r.proton_pulse_user_id === currentUserId;
    const removeBtn = isSelf
      ? `<button class="admin-btn admin-btn--danger admin-btn--sm" disabled title="Cannot remove yourself">Remove</button>`
      : `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="remove-admin" data-uuid="${uid}" data-name="${name}">Remove</button>`;
    // data-perms/data-role let the delegated handler compute the next set without a re-fetch.
    return `<tr data-uuid="${uid}" data-role="${escapeHtml(label)}" data-perms="${escapeHtml(eff.join(','))}">
      <td>${name}</td>
      <td>${roleSelectHtml(label, uid)}</td>
      <td>${permEditorHtml(label, eff, uid)}</td>
      <td>${escapeHtml(fmtDateTime(r.added_at))}</td>
      <td>${removeBtn}</td>
    </tr>`;
  }).join('');
}
