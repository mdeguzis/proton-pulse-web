import { SupaAuth, SUPABASE_URL } from './config.js?v=ffed3d84';
import { supabaseHeaders, escapeHtml } from './utils.js?v=bd5a67c2';
import { effectivePermissions, hasPermission, canSeeTab, resolveRoleLabel, PERMISSION_LABELS, presetFor, addPermission, removePermission } from './permissions.js?v=529eb059';
import { fetchFlaggedReports, updateFlagStatus, deleteFlaggedReport, fetchFlagReportContent, findPulseConfigId, shadowBanReport, releaseReportContent, deleteReportContent, suppressMirrorReport, unsuppressMirrorReport, fetchReportState } from './api/flagged.js?v=9359a45e';
import { renderFlagged, renderFlagDetail } from './components/flagged.js?v=5e2c6b60';
import { fetchBannedUsers, banUser, unbanUser } from './api/banned.js?v=0d6ec118';
import { renderBanned } from './components/banned.js?v=7bb95620';
import { fetchAllUsers } from './api/users.js?v=0acf098a';
import { renderUsers } from './components/users.js?v=6d46e622';
import { fetchAdmins, addAdmin, removeAdmin, updateAdminRole } from './api/admins.js?v=2ad9f027';
import { renderAdmins, renderNewAdminEditor } from './components/admins.js?v=04c577e8';
import { fetchBannedPhrases, addBannedPhrase, removeBannedPhrase, toggleBannedPhrase } from './api/phrases.js?v=ac74cb89';
import { renderPhrases } from './components/phrases.js?v=5fb05dc2';
import { loadWordlist, checkAgainstWordlist } from './api/wordlist.js?v=51c55965';
import { fetchUserReports, fetchUserActivity } from './api/userDetail.js?v=28cb08af';
import { renderUserDetail } from './components/userDetail.js?v=5ff164c0';
import { fetchAnalytics } from './api/analytics.js?v=ad63b2e7';
import { renderAnalytics } from './components/analytics.js?v=0e977dd7';
import { renderCacheStatus } from './components/cache-status.js?v=0c6c0cb7';
import { renderAllReports, updateAllReportsRow, renderAllReportsDetail } from './components/allReports.js?v=c8c8396a';
import { patchReportFlags, fetchReportById } from './api/allReports.js?v=7e28c862';
import { approveReport } from './api/pending.js?v=84292a58';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSession = null;
let flaggedRows = [];
let bannedRows = [];
let sortField = 'flagged_at';
let sortDir = 'desc';
let userDetailReturnTab = 'users';

// ---------------------------------------------------------------------------
// Supabase queries
// ---------------------------------------------------------------------------

// Fetch the signed-in user's admin row (role + granular permissions), or null
// if they are not an admin. Drives both access and what the panel shows.
async function fetchAdminProfile(session) {
  if (!session?.user?.id) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${encodeURIComponent(session.user.id)}&select=role,permissions&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders(session) });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

// The signed-in admin's effective capabilities. `can(perm)` is the front-end
// mirror of the RLS helper current_user_has_permission(); RLS stays the real
// gate, this just decides what to show.
let currentAdmin = null; // { role, permissions }
function can(perm) {
  return currentAdmin ? hasPermission(currentAdmin.role, currentAdmin.permissions, perm) : false;
}

const ROLE_DISPLAY = { super_admin: 'Super Admin', moderator: 'Moderator', custom: 'Custom' };

// Show the signed-in admin's role + what they can do at the top of the panel.
function renderPermissionSummary() {
  const el = document.getElementById('admin-perms-summary');
  if (!el || !currentAdmin) return;
  const label = resolveRoleLabel(currentAdmin.role, currentAdmin.permissions);
  const caps = effectivePermissions(currentAdmin.role, currentAdmin.permissions)
    .map(k => PERMISSION_LABELS[k] || k);
  el.innerHTML =
    `<span class="admin-perms-label">Your access</span>` +
    `<span class="admin-perms-role">${escapeHtml(ROLE_DISPLAY[label] || label)}</span>` +
    `<span class="admin-perms-caps">${caps.length ? escapeHtml(caps.join(' · ')) : 'no permissions'}</span>`;
  el.hidden = false;
}

// Hide tab options the current admin cannot use (the real gate is RLS).
function applyTabVisibility() {
  const sel = document.getElementById('admin-tab-select');
  if (!sel || !currentAdmin) return;
  Array.from(sel.options).forEach(opt => {
    opt.hidden = !canSeeTab(currentAdmin.role, currentAdmin.permissions, opt.value);
  });
}

// --- Admin role/permission assignment (Admins tab) ----------------------------
// The add-admin form keeps a draft role + permission set; existing admins are
// edited in-place and persisted immediately. uuid 'new' targets the draft.
let newAdminRole = 'moderator';
let newAdminPerms = presetFor('moderator');

function syncNewAdminForm() {
  const sel = document.getElementById('new-admin-role');
  if (sel) sel.value = newAdminRole;
  renderNewAdminEditor(newAdminRole, newAdminPerms);
}

// Current permission set for a uuid: draft state for 'new', else the row's data.
function currentRowPerms(uuid) {
  if (uuid === 'new') return newAdminPerms.slice();
  const tr = document.querySelector(`#admins-tbody tr[data-uuid="${uuid}"]`);
  return tr && tr.dataset.perms ? tr.dataset.perms.split(',').filter(Boolean) : [];
}

// Apply a (role, permissions) change: update draft for 'new', else persist + reload.
async function applyAdminChange(uuid, role, permissions) {
  if (uuid === 'new') {
    newAdminRole = role;
    newAdminPerms = permissions;
    syncNewAdminForm();
    return;
  }
  await updateAdminRole(currentSession, uuid, { role, permissions });
  loadAdmins();
}

// ---------------------------------------------------------------------------
// Load sections
// ---------------------------------------------------------------------------

async function loadAllReports() {
  await renderAllReports(currentSession);
}

// #48: helper that prompts a moderator for a free-text reason before
// applying a flag or hide. Returning null means the prompt was cancelled
// and the caller should abort -- a confirmed empty string is treated the
// same so an admin who clicks OK with nothing typed does not silently
// blank the flagged_reason column.
function promptFlagReason(action) {
  const verb = action === 'ar-hide' ? 'hide' : 'flag';
  const raw = window.prompt(
    `Reason to ${verb} this report? (e.g. spam, test, fake-id, off-topic)\n` +
    `Cancel to abort.`
  );
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Cap the stored reason so an accidental paste does not blow up the row.
  return trimmed.slice(0, 200);
}

async function loadReportDetail(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('reportid', String(id));
  url.searchParams.delete('detail');
  url.searchParams.delete('flagid');
  history.pushState({ adminView: 'report-detail' }, '', url);

  document.querySelectorAll('.admin-section').forEach(sec => { sec.hidden = true; });
  document.getElementById('tab-report-detail').hidden = false;
  document.getElementById('admin-tab-select').value = '';

  const content = document.getElementById('report-detail-content');
  content.innerHTML = '<div class="admin-loading">Loading report...</div>';

  try {
    const report = await fetchReportById(currentSession, id);
    renderAllReportsDetail(report, {
      onBack: () => activateTab('all-reports'),
      onAction: async (action, rid, btn) => {
        try {
          if (action === 'ar-flag') {
            const reason = promptFlagReason(action);
            if (reason === null) { if (btn) btn.disabled = false; return; }
            await patchReportFlags(currentSession, rid, {
              is_flagged: true,
              flagged_reason: reason,
              flagged_at: new Date().toISOString(),
            });
            updateAllReportsRow(rid, true, false, reason);
          } else if (action === 'ar-hide') {
            const reason = promptFlagReason(action);
            if (reason === null) { if (btn) btn.disabled = false; return; }
            await patchReportFlags(currentSession, rid, {
              is_flagged: true,
              is_hidden: true,
              flagged_reason: reason,
              flagged_at: new Date().toISOString(),
            });
            updateAllReportsRow(rid, true, true, reason);
          } else if (action === 'ar-release') {
            await patchReportFlags(currentSession, rid, {
              is_flagged: false,
              is_hidden: false,
              flagged_reason: null,
              flagged_at: null,
            });
            updateAllReportsRow(rid, false, false, null);
          } else if (action === 'ar-approve') {
            // #146: same approval row the Pending Approvals tab writes,
            // so the next pipeline pass keeps the report public.
            await approveReport(currentSession, report);
            updateAllReportsRow(rid, false, false, null, false);
          } else if (action === 'ar-deny') {
            // #146: Deny prompts for a reason and shuts the report out
            // of the public listing (is_hidden + is_flagged). Same data
            // shape as Hide, just a different button label so the
            // moderation intent reads cleanly in the audit trail.
            const reason = promptFlagReason(action);
            if (reason === null) { if (btn) btn.disabled = false; return; }
            await patchReportFlags(currentSession, rid, {
              is_flagged: true,
              is_hidden: true,
              flagged_reason: 'denied: ' + reason,
              flagged_at: new Date().toISOString(),
            });
            updateAllReportsRow(rid, true, true, 'denied: ' + reason, false);
          }
          window.ppToast?.success('Report updated.');
        } catch (err) {
          if (btn) btn.disabled = false;
          window.ppToast?.error(err.message);
        }
      },
    });
  } catch (err) {
    content.innerHTML = `<div class="admin-error">${err.message}</div>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="ar-back" style="margin-top:10px">&#8592; Back to reports</button>`;
    content.querySelector('[data-action="ar-back"]')?.addEventListener('click', () => activateTab('all-reports'));
  }
}

async function loadFlagged() {
  const loading = document.getElementById('flagged-loading');
  const errEl   = document.getElementById('flagged-error');
  const empty   = document.getElementById('flagged-empty');
  const table   = document.getElementById('flagged-table');

  loading.hidden = false;
  errEl.hidden = true;
  empty.hidden = true;
  table.hidden = true;

  try {
    const search   = document.getElementById('flagged-search').value.trim();
    const type     = document.getElementById('flagged-type').value;
    const dateFrom = document.getElementById('flagged-date-from').value;
    const dateTo   = document.getElementById('flagged-date-to').value;
    const openOnly = document.getElementById('flagged-open-only')?.checked;
    flaggedRows = await fetchFlaggedReports(currentSession, { search, type, dateFrom, dateTo, sortField, sortDir });
    const displayRows = openOnly ? flaggedRows.filter(r => (r.status || 'open') === 'open') : flaggedRows;
    renderFlagged(displayRows);
  } catch (e) {
    loading.hidden = true;
    errEl.textContent = e.message;
    errEl.hidden = false;
  }
}

async function loadBanned() {
  const loading = document.getElementById('banned-loading');
  const errEl   = document.getElementById('banned-error');
  const empty   = document.getElementById('banned-empty');
  const table   = document.getElementById('banned-table');

  loading.hidden = false;
  errEl.hidden = true;
  empty.hidden = true;
  table.hidden = true;

  try {
    const search = document.getElementById('banned-search').value.trim();
    bannedRows = await fetchBannedUsers(currentSession, { search });
    renderBanned(bannedRows);
  } catch (e) {
    loading.hidden = true;
    errEl.textContent = e.message;
    errEl.hidden = false;
  }
}

async function loadUsers() {
  const loading = document.getElementById('users-loading');
  const err     = document.getElementById('users-error');
  const search  = document.getElementById('users-search')?.value.trim() || '';
  // Reflect the search in the URL as ?search= so it is bookmarkable and survives
  // a refresh (mirrors the existing ?tab= / ?detail= params).
  const searchUrl = new URL(window.location.href);
  if (search) searchUrl.searchParams.set('search', search);
  else searchUrl.searchParams.delete('search');
  history.replaceState(null, '', searchUrl);
  loading.hidden = false;
  err.hidden = true;
  try {
    const { rows, counts } = await fetchAllUsers(currentSession, { search });
    renderUsers(rows, { currentUserId: currentSession?.user?.id, counts, canBan: can('ban_users') });
  } catch (e) {
    loading.hidden = true;
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function loadAdmins() {
  try {
    syncNewAdminForm();
    const rows = await fetchAdmins(currentSession);
    renderAdmins(rows, { currentUserId: currentSession?.user?.id });
  } catch (e) {
    document.getElementById('admins-loading').hidden = true;
    document.getElementById('admins-empty').textContent = e.message;
    document.getElementById('admins-empty').hidden = false;
  }
}

async function loadPhrases() {
  const loading = document.getElementById('phrases-loading');
  const err     = document.getElementById('phrases-error');
  loading.hidden = false;
  err.hidden = true;
  try {
    const rows = await fetchBannedPhrases(currentSession);
    renderPhrases(rows);
  } catch (e) {
    loading.hidden = true;
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function loadUserDetail(user) {
  userDetailReturnTab = document.getElementById('admin-tab-select').value || 'users';
  // Persist user so a page refresh can restore this view.
  sessionStorage.setItem('admin_detail_user', JSON.stringify(user));
  const url = new URL(window.location.href);
  url.searchParams.set('detail', user.proton_pulse_user_id || user.client_id || '1');
  history.pushState({ adminView: 'user-detail' }, '', url);

  // Show the detail section and hide all tab sections.
  document.querySelectorAll('.admin-section').forEach(sec => { sec.hidden = true; });
  const detailSection = document.getElementById('tab-user-detail');
  detailSection.hidden = false;
  // Clear the select so no option appears active while on the detail screen.
  document.getElementById('admin-tab-select').value = '';

  const content = document.getElementById('user-detail-content');
  content.innerHTML = '<div class="admin-loading">Loading reports...</div>';

  try {
    const uid = user.proton_pulse_user_id || null;
    const [reports, authEvents, avatarRows, authRows] = await Promise.all([
      fetchUserReports(currentSession, { userId: uid, clientId: user.client_id || null }),
      fetchUserActivity(currentSession, { userId: uid }),
      uid ? fetch(`${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${encodeURIComponent(uid)}&select=last_seen_at`, { headers: supabaseHeaders(currentSession) }).then(r => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),
      uid ? fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_users`, { method: 'POST', headers: { ...supabaseHeaders(currentSession), 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.ok ? r.json() : []).catch(() => []) : Promise.resolve([]),
    ]);

    // Re-derive last_active from all available signals so the detail view
    // always reflects the most recent one, independent of what was serialized
    // into the button's data-userobj at render time.
    const avatarRow  = avatarRows[0];
    const authUser   = uid ? authRows.find(a => a.id === uid) : null;
    const candidates = [
      user.last_active,
      avatarRow?.last_seen_at,
      authUser?.last_sign_in_at,
    ].filter(Boolean);
    if (candidates.length) {
      user.last_active = candidates.reduce((a, b) => (a > b ? a : b));
    }
    if (authUser?.last_sign_in_at) user.last_login = authUser.last_sign_in_at;

    renderUserDetail(user, reports, authEvents, {
      session: currentSession,
      currentUserId: currentSession?.user?.id,
    });
    const backBtn = content.querySelector('[data-action="back-to-users"]');
    if (backBtn) backBtn.textContent = `\u2190 Back to ${userDetailReturnTab.replace('-', ' ')}`;
  } catch (e) {
    content.innerHTML = `<div class="admin-error">${e.message}</div>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" data-action="back-to-users" style="margin-top:10px">\u2190 Back to ${userDetailReturnTab.replace('-', ' ')}</button>`;
  }
}

async function loadFlagDetail(row) {
  sessionStorage.setItem('admin_detail_flag', JSON.stringify(row));
  const url = new URL(window.location.href);
  url.searchParams.set('flagid', String(row.id));
  url.searchParams.delete('detail');
  history.pushState({ adminView: 'flag-detail' }, '', url);

  document.querySelectorAll('.admin-section').forEach(sec => { sec.hidden = true; });
  document.getElementById('tab-flag-detail').hidden = false;
  document.getElementById('admin-tab-select').value = '';
  const content = document.getElementById('flag-detail-content');
  content.innerHTML = '<div class="admin-loading">Loading report...</div>';
  const [reportContent, modState] = await Promise.all([
    fetchFlagReportContent(currentSession, row),
    fetchReportState(currentSession, { app_id: row.app_id, report_key: row.report_key, source: row.source }),
  ]);
  content.innerHTML = renderFlagDetail(row, reportContent, modState);
}

// ---------------------------------------------------------------------------
// Ban modal
// ---------------------------------------------------------------------------

let pendingBan = null;

function openBanModal(userId, clientId, username) {
  pendingBan = { userId, clientId, username };
  document.getElementById('ban-modal-user').textContent = `User: ${username}`;
  document.getElementById('ban-reason-input').value = '';
  document.getElementById('ban-modal').hidden = false;
  document.getElementById('ban-reason-input').focus();
}

function closeBanModal() {
  pendingBan = null;
  document.getElementById('ban-modal').hidden = true;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tabName) {
  const sel = document.getElementById('admin-tab-select');
  if (sel.value !== tabName) sel.value = tabName;
  document.querySelectorAll('.admin-section').forEach(sec => {
    sec.hidden = sec.id !== `tab-${tabName}`;
  });
}

let analyticsDays = 30;

async function loadAnalytics() {
  const content = document.getElementById('analytics-content');
  content.innerHTML = '<div class="admin-loading">Loading...</div>';
  try {
    const data = await fetchAnalytics(currentSession, { daysBack: analyticsDays });
    renderAnalytics(data, {
      daysBack: analyticsDays,
      onChangeDays: (d) => { analyticsDays = d; loadAnalytics(); },
    });
  } catch (e) {
    content.innerHTML = `<div class="admin-error">${e.message}</div>`;
  }
  const cacheContainer = document.getElementById('cache-status-content');
  if (cacheContainer) renderCacheStatus(cacheContainer).catch(() => {});
}

// Maps each tab to its data loader so tab clicks and ?tab= restore share one path.
const TAB_LOADERS = {
  'all-reports': loadAllReports,
  flagged: loadFlagged,
  banned: loadBanned,
  users: loadUsers,
  admins: loadAdmins,
  phrases: loadPhrases,
  analytics: loadAnalytics,
};

// Activate a tab, load its data, and reflect it in the URL as ?tab=<name> so a
// refresh restores the same tab. Unknown names fall back to 'users' (the
// default landing tab).
function activateTab(tabName, { updateUrl = true } = {}) {
  if (tabName === 'pending') tabName = 'all-reports';
  if (!TAB_LOADERS[tabName]) tabName = 'users';
  // Never land on a tab this admin lacks access to (e.g. via a stale ?tab= URL).
  if (currentAdmin && !canSeeTab(currentAdmin.role, currentAdmin.permissions, tabName)) tabName = 'users';
  switchTab(tabName);
  // ?search= is specific to the Users tab. When entering Users, restore the box
  // from the URL (so a bookmarked/refreshed ?search= filters on load). The input
  // keeps its own value across tab switches, so only overwrite it when the URL
  // actually carries a search term.
  const searchInput = document.getElementById('users-search');
  if (tabName === 'users' && searchInput) {
    const urlSearch = new URLSearchParams(window.location.search).get('search');
    if (urlSearch !== null) searchInput.value = urlSearch;
    // Keep the inline clear (X) button in sync with the restored value.
    const clearBtn = document.getElementById('users-search-clear');
    if (clearBtn) clearBtn.hidden = !searchInput.value;
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabName);
    url.searchParams.delete('detail');
    url.searchParams.delete('flagid');
    // Drop the Users-only search param when viewing any other tab.
    if (tabName !== 'users') url.searchParams.delete('search');
    history.replaceState(null, '', url);
  }
  TAB_LOADERS[tabName]();
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

function wireEvents() {
  // Tab select -- activateTab updates ?tab= so the choice survives a refresh
  document.getElementById('admin-tab-select').addEventListener('change', e => {
    activateTab(e.target.value);
  });

  // Sort buttons
  document.querySelectorAll('.admin-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newField = btn.dataset.sort;
      if (sortField === newField) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = newField;
        sortDir = btn.dataset.dir;
      }
      document.querySelectorAll('.admin-sort-btn').forEach(b => b.classList.toggle('admin-sort-btn--active', b.dataset.sort === sortField));
      loadFlagged();
    });
  });

  // Refresh buttons
  document.getElementById('all-reports-refresh-btn').addEventListener('click', loadAllReports);
  document.getElementById('flagged-refresh-btn').addEventListener('click', loadFlagged);
  document.getElementById('banned-refresh-btn').addEventListener('click', loadBanned);
  document.getElementById('users-refresh-btn').addEventListener('click', loadUsers);

  // Search inputs - live filter on enter
  document.getElementById('all-reports-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadAllReports(); });
  document.getElementById('all-reports-status-filter').addEventListener('change', loadAllReports);
  document.getElementById('all-reports-date-from').addEventListener('change', loadAllReports);
  document.getElementById('all-reports-date-to').addEventListener('change', loadAllReports);
  document.getElementById('flagged-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadFlagged(); });
  document.getElementById('flagged-type').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-from').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-to').addEventListener('change', loadFlagged);
  document.getElementById('flagged-open-only').addEventListener('change', loadFlagged);
  document.getElementById('banned-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadBanned(); });
  document.getElementById('users-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadUsers(); });

  // Users search: inline clear (X) button, only visible when there is text.
  const usersSearchEl = document.getElementById('users-search');
  const usersSearchClearEl = document.getElementById('users-search-clear');
  usersSearchEl.addEventListener('input', () => { usersSearchClearEl.hidden = !usersSearchEl.value; });
  usersSearchClearEl.addEventListener('click', () => {
    usersSearchEl.value = '';
    usersSearchClearEl.hidden = true;
    usersSearchEl.focus();
    loadUsers();
  });

  // Flagged table: Review button opens detail view
  document.getElementById('flagged-tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="review-flag"]');
    if (!btn) return;
    const id = btn.dataset.id;
    const row = flaggedRows.find(r => String(r.id) === id);
    if (row) loadFlagDetail(row);
  });

  // Flag detail: status actions + delete + back
  document.getElementById('flag-detail-content').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'back-to-flagged') {
      activateTab('flagged');
      return;
    }

    if (action === 'flag-set-status') {
      const newStatus = btn.dataset.status;
      const id = btn.dataset.id;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await updateFlagStatus(currentSession, id, newStatus);
        const STATUS_LABELS = { open: 'Open', in_review: 'In Review', complete: 'Complete' };
        const statusEl = document.getElementById('flag-detail-status');
        if (statusEl) {
          statusEl.textContent = STATUS_LABELS[newStatus] || newStatus;
          statusEl.className = `admin-status admin-status--${newStatus}`;
        }
        const target = flaggedRows.find(r => String(r.id) === id);
        if (target) target.status = newStatus;
        btn.disabled = false;
        btn.textContent = origText;
        window.ppToast?.success(`Status set to ${STATUS_LABELS[newStatus] || newStatus}.`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = origText;
        window.ppToast?.error(`Could not update status: ${err.message}`);
      }
    }

    if (action === 'flag-delete') {
      if (!confirm('Delete this flag entry permanently?')) return;
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await deleteFlaggedReport(currentSession, id);
        flaggedRows = flaggedRows.filter(r => String(r.id) !== id);
        activateTab('flagged');
        window.ppToast?.success('Flag entry deleted.');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        window.ppToast?.error(`Could not delete flag: ${err.message}`);
      }
    }

    // Report-level moderation (Pulse reports). Each resolves the underlying
    // user_configs row, acts on it, then marks the flag complete.
    if (action === 'flag-shadowban' || action === 'flag-release' || action === 'flag-delete-report') {
      const id = btn.dataset.id;
      const flag = flaggedRows.find(r => String(r.id) === id);
      if (!flag) return;
      const confirmMsg = {
        'flag-shadowban': 'Shadow ban this report? It stays visible to the submitter but nobody else.',
        'flag-release': 'Release this report? It will be kept and its flagged/hidden state cleared.',
        'flag-delete-report': 'Permanently delete this report content? This cannot be undone.',
      }[action];
      if (!confirm(confirmMsg)) return;
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        // Pulse reports have a user_configs row we edit directly. ProtonDB
        // mirror reports do not, so we record a suppression instead. Either way
        // the action works -- our site, our rules on what we display.
        const configId = await findPulseConfigId(currentSession, flag.app_id, flag.report_key);
        if (configId) {
          if (action === 'flag-shadowban') await shadowBanReport(currentSession, configId);
          else if (action === 'flag-release') await releaseReportContent(currentSession, configId);
          else await deleteReportContent(currentSession, configId);
        } else {
          const ref = { flagId: flag.id, appId: flag.app_id, reportKey: flag.report_key, source: flag.source, flaggedAt: flag.flagged_at };
          if (action === 'flag-release') await unsuppressMirrorReport(currentSession, ref);
          else await suppressMirrorReport(currentSession, { ...ref, action: action === 'flag-delete-report' ? 'deleted' : 'shadowban' });
        }
        // Resolve the flag now that the report has been handled.
        await updateFlagStatus(currentSession, id, 'complete');
        const target = flaggedRows.find(r => String(r.id) === id);
        if (target) target.status = 'complete';
        // Stay on the detail and re-render with the new state (e.g. Shadow ban
        // flips to Un-shadow ban) instead of bouncing back to the list. Only the
        // Back button / browser back should leave this screen.
        await loadFlagDetail(target || flag);
        const doneMsg = {
          'flag-shadowban': 'Report shadow banned.',
          'flag-release': 'Report released and made visible.',
          'flag-delete-report': 'Report deleted.',
        }[action];
        window.ppToast?.success(doneMsg);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = origText;
        window.ppToast?.error(`Action failed: ${err.message}`);
      }
    }
  });

  // All Reports table actions (delegated)
  document.getElementById('all-reports-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'view-user-detail') {
      let user;
      try { user = JSON.parse(btn.dataset.userobj); } catch (_) { return; }
      loadUserDetail(user);
      return;
    }

    if (action === 'ar-view-detail') {
      const rid = btn.dataset.rid;
      if (!rid) return;
      loadReportDetail(rid);
    }
  });

  // Users table actions (delegated)
  document.getElementById('users-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy-id') {
      const val = btn.dataset.value || '';
      navigator.clipboard.writeText(val).then(() => {
        const tip = document.createElement('span');
        tip.className = 'copy-tooltip';
        tip.textContent = 'Copied';
        btn.appendChild(tip);
        requestAnimationFrame(() => tip.classList.add('copy-tooltip--show'));
        setTimeout(() => tip.remove(), 1000);
      }).catch(() => {});
      return;
    }
    if (action === 'ban-user') {
      // Pass BOTH ids: anonymous users have only client_id, Steam users have
      // proton_pulse_user_id. Sending only userid for an anonymous user left the
      // ban with no identity and the insert failed the has-identity CHECK (400).
      openBanModal(btn.dataset.userid || null, btn.dataset.clientid || null, btn.dataset.username);
    }
    if (action === 'unban-user') {
      if (!confirm('Unban this user and restore their reports?')) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await unbanUser(currentSession, btn.dataset.banId, { protonPulseUserId: btn.dataset.userid, clientId: btn.dataset.clientid });
        window.ppToast?.success('User unbanned. Their reports are visible again.');
        loadUsers();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Unban';
        window.ppToast?.error(err.message);
      }
    }
    if (action === 'view-user-detail') {
      // The trigger is now an anchor (#139) so stop the default # nav before
      // routing to the detail view.
      e.preventDefault();
      let user;
      try {
        user = JSON.parse(btn.dataset.userobj);
      } catch (_) {
        window.ppToast?.error('Could not parse user data.');
        return;
      }
      loadUserDetail(user);
    }
  });

  // User detail actions (delegated on the detail content container)
  document.getElementById('user-detail-content').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'back-to-users') {
      activateTab(userDetailReturnTab);
    }
    if (action === 'ar-view-detail') {
      // #150: unified row template -- clicking #NNN on a report row
      // inside the user detail opens the same report detail panel the
      // All Reports table uses.
      const rid = btn.dataset.rid;
      if (rid) loadReportDetail(rid);
      return;
    }
    if (action === 'ban-from-detail') {
      openBanModal(btn.dataset.userid || null, btn.dataset.clientid || null, btn.dataset.username);
    }
    if (action === 'unban-from-detail') {
      if (!confirm('Unban this user and restore their reports?')) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await unbanUser(currentSession, btn.dataset.banId, { protonPulseUserId: btn.dataset.userid, clientId: btn.dataset.clientid });
        window.ppToast?.success('User unbanned.');
        activateTab(userDetailReturnTab);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Unban';
        window.ppToast?.error(err.message);
      }
    }
  });

  // Banned table actions (delegated)
  document.getElementById('banned-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="unban"]');
    if (!btn) return;
    if (!confirm('Unban this user and restore their reports?')) return;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      await unbanUser(currentSession, btn.dataset.banId, { protonPulseUserId: btn.dataset.userId, clientId: btn.dataset.clientId });
      btn.closest('tr').remove();
      window.ppToast?.success('User unbanned.');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Unban';
      window.ppToast?.error(err.message);
    }
  });

  // Ban modal
  document.getElementById('ban-confirm-btn').addEventListener('click', async () => {
    if (!pendingBan) return;
    const reason = document.getElementById('ban-reason-input').value.trim();
    if (!reason) {
      const input = document.getElementById('ban-reason-input');
      input.focus();
      input.style.borderColor = 'var(--red, #e06c75)';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
      return;
    }
    const confirmBtn = document.getElementById('ban-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '...';
    try {
      await banUser(currentSession, {
        protonPulseUserId: pendingBan.userId || null,
        clientId: pendingBan.clientId || null,
        steamUsername: pendingBan.username,
        reason,
      });
      closeBanModal();
      window.ppToast?.success(`Banned ${pendingBan.username || 'user'}.`);
      // Refresh the users list so the newly banned user shows Unban.
      loadUsers();
    } catch (err) {
      window.ppToast?.error(err.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Ban';
    }
  });

  document.getElementById('ban-cancel-btn').addEventListener('click', closeBanModal);
  document.getElementById('ban-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBanModal();
  });

  // Browser back button / swipe back from detail screens.
  window.addEventListener('popstate', e => {
    if (!document.getElementById('tab-user-detail').hidden) activateTab(userDetailReturnTab);
    else if (!document.getElementById('tab-flag-detail').hidden) activateTab('flagged');
    else if (!document.getElementById('tab-report-detail').hidden) activateTab('all-reports');
  });

  // Add admin form
  document.getElementById('add-admin-btn').addEventListener('click', async () => {
    const uuid     = document.getElementById('new-admin-uuid').value.trim();
    const username = document.getElementById('new-admin-username').value.trim();
    const status   = document.getElementById('add-admin-status');
    if (!uuid || !username) { status.textContent = 'UUID and username are required.'; status.style.color = 'var(--red)'; return; }
    // super_admin always means all permissions; otherwise the role label is
    // derived from the chosen permission set (moderator preset or custom).
    const role = newAdminRole === 'super_admin' ? 'super_admin' : resolveRoleLabel('moderator', newAdminPerms);
    const permissions = newAdminRole === 'super_admin' ? presetFor('super_admin') : newAdminPerms;
    try {
      await addAdmin(currentSession, { uuid, username, role, permissions });
      window.ppToast?.success(`Added ${username} as admin.`);
      status.textContent = '';
      document.getElementById('new-admin-uuid').value = '';
      document.getElementById('new-admin-username').value = '';
      newAdminRole = 'moderator';
      newAdminPerms = presetFor('moderator');
      syncNewAdminForm();
      loadAdmins();
    } catch (e) {
      window.ppToast?.error(e.message);
    }
  });

  // Admins tab: role change + add/remove permission, for both existing rows and
  // the add form (data-uuid="new"). Delegated on the whole section so it covers
  // the re-rendered chips, the add dropdown, and the form's role select.
  const adminsTab = document.getElementById('tab-admins');

  adminsTab.addEventListener('change', async e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, uuid } = el.dataset;
    try {
      if (action === 'change-role') {
        const role = el.value;
        let perms;
        if (role === 'super_admin') perms = presetFor('super_admin');
        else if (role === 'moderator') perms = presetFor('moderator');
        else perms = currentRowPerms(uuid); // custom keeps the current set
        await applyAdminChange(uuid, role, perms);
      } else if (action === 'add-perm') {
        if (!el.value) return;
        const perms = addPermission(currentRowPerms(uuid), el.value);
        await applyAdminChange(uuid, resolveRoleLabel('moderator', perms), perms);
      }
    } catch (err) {
      window.ppToast?.error(err.message);
      if (uuid !== 'new') loadAdmins();
    }
  });

  adminsTab.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, uuid } = btn.dataset;
    if (action === 'remove-admin') {
      if (!confirm(`Remove ${btn.dataset.name} as admin?`)) return;
      btn.disabled = true; btn.textContent = '...';
      try {
        await removeAdmin(currentSession, uuid);
        window.ppToast?.success(`Removed ${btn.dataset.name} as admin.`);
        loadAdmins();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Remove';
        window.ppToast?.error(err.message);
      }
    } else if (action === 'remove-perm') {
      try {
        const perms = removePermission(currentRowPerms(uuid), btn.dataset.perm);
        await applyAdminChange(uuid, resolveRoleLabel('moderator', perms), perms);
      } catch (err) {
        window.ppToast?.error(err.message);
        if (uuid !== 'new') loadAdmins();
      }
    }
  });

  // Regex checkbox: show/hide Validate button
  document.getElementById('new-phrase-is-regex').addEventListener('change', e => {
    document.getElementById('validate-regex-btn').hidden = !e.target.checked;
  });

  // Validate regex button
  document.getElementById('validate-regex-btn').addEventListener('click', async () => {
    const pattern = document.getElementById('new-phrase-pattern').value.trim();
    const status  = document.getElementById('add-phrase-status');
    if (!pattern) { status.textContent = 'Enter a pattern to validate.'; status.style.color = 'var(--red)'; return; }
    try {
      new RegExp(pattern);
    } catch (e) {
      status.textContent = `Invalid regex: ${e.message}`;
      status.style.color = 'var(--red)';
      return;
    }
    status.textContent = 'Checking wordlist...';
    status.style.color = '';
    const terms = await loadWordlist();
    const hits = checkAgainstWordlist(pattern, true, terms);
    if (hits) {
      status.textContent = `Valid regex, but already covered by built-in wordlist (e.g. ${hits.join(', ')}).`;
      status.style.color = 'var(--yellow, #e8c84a)';
    } else {
      status.textContent = `Valid regex. Not covered by built-in wordlist.`;
      status.style.color = 'var(--green)';
    }
  });

  // Add banned phrase
  document.getElementById('add-phrase-btn').addEventListener('click', async () => {
    const pattern     = document.getElementById('new-phrase-pattern').value.trim();
    const is_regex    = document.getElementById('new-phrase-is-regex').checked;
    const description = document.getElementById('new-phrase-description').value.trim();
    const status      = document.getElementById('add-phrase-status');
    if (!pattern) { status.textContent = 'Pattern is required.'; status.style.color = 'var(--red)'; return; }
    if (is_regex) {
      try { new RegExp(pattern); } catch {
        status.textContent = 'Invalid regex pattern.'; status.style.color = 'var(--red)'; return;
      }
    }
    try {
      const terms = await loadWordlist();
      const hits = checkAgainstWordlist(pattern, is_regex, terms);
      await addBannedPhrase(currentSession, { pattern, is_regex, description });
      status.textContent = hits
        ? `Phrase added (note: already covered by built-in wordlist: ${hits.join(', ')}).`
        : 'Phrase added.';
      status.style.color = hits ? 'var(--yellow, #e8c84a)' : 'var(--green)';
      document.getElementById('new-phrase-pattern').value = '';
      document.getElementById('new-phrase-is-regex').checked = false;
      document.getElementById('new-phrase-description').value = '';
      loadPhrases();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--red)';
    }
  });

  // Phrases table: toggle / remove (delegated)
  document.getElementById('phrases-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'remove-phrase') {
      if (!confirm('Remove this banned phrase?')) return;
      btn.disabled = true; btn.textContent = '...';
      try {
        await removeBannedPhrase(currentSession, id);
        btn.closest('tr').remove();
        window.ppToast?.success('Banned phrase removed.');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Remove';
        window.ppToast?.error(err.message);
      }
    }

    if (action === 'toggle-phrase') {
      const enabled = btn.dataset.enabled !== 'true';
      btn.disabled = true; btn.textContent = '...';
      try {
        await toggleBannedPhrase(currentSession, id, enabled);
        window.ppToast?.success(enabled ? 'Phrase enabled.' : 'Phrase disabled.');
        loadPhrases();
      } catch (err) {
        btn.disabled = false;
        window.ppToast?.error(err.message);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Generic client-side table sort
// ---------------------------------------------------------------------------

function setupTableSort(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const ths = table.querySelectorAll('thead th[data-sort-col]');
  ths.forEach(th => {
    const indicator = document.createElement('span');
    indicator.className = 'sort-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    th.appendChild(indicator);

    th.addEventListener('click', () => {
      const col  = parseInt(th.dataset.sortCol, 10);
      const type = th.dataset.sortType || 'text';
      const tbody = table.querySelector('tbody');
      if (!tbody) return;

      const wasActive = th.dataset.sortActive === '1';
      const nowAsc    = wasActive ? th.dataset.sortDir !== 'asc' : true;

      ths.forEach(h => {
        h.dataset.sortActive = '';
        h.dataset.sortDir    = '';
        h.classList.remove('admin-th--sorted');
        const ind = h.querySelector('.sort-indicator');
        if (ind) ind.textContent = '';
      });

      th.dataset.sortActive = '1';
      th.dataset.sortDir    = nowAsc ? 'asc' : 'desc';
      th.classList.add('admin-th--sorted');
      indicator.textContent = nowAsc ? ' \u25b2' : ' \u25bc';

      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        const aVal = a.cells[col]?.textContent.trim() ?? '';
        const bVal = b.cells[col]?.textContent.trim() ?? '';
        let cmp = 0;
        if (type === 'number') {
          cmp = (parseFloat(aVal) || 0) - (parseFloat(bVal) || 0);
        } else if (type === 'date') {
          const at = Date.parse(aVal);
          const bt = Date.parse(bVal);
          cmp = (isNaN(at) ? 0 : at) - (isNaN(bt) ? 0 : bt);
        } else {
          cmp = aVal.localeCompare(bVal, undefined, { sensitivity: 'base' });
        }
        return nowAsc ? cmp : -cmp;
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const panel      = document.getElementById('admin-panel');
  const signedOut  = document.getElementById('admin-signed-out');
  const notAuth    = document.getElementById('admin-not-authorized');

  const session = await SupaAuth.getSession();
  currentSession = session;

  if (!session?.user) {
    signedOut.hidden = false;
    return;
  }

  currentAdmin = await fetchAdminProfile(session);
  if (!currentAdmin) {
    notAuth.hidden = false;
    return;
  }

  panel.hidden = false;
  renderPermissionSummary();
  applyTabVisibility();
  wireEvents();
  ['flagged-table', 'banned-table', 'users-table', 'admins-table', 'phrases-table'].forEach(setupTableSort);

  const params = new URLSearchParams(window.location.search);

  const reportIdParam = params.get('reportid');
  if (reportIdParam) {
    loadReportDetail(reportIdParam);
    return;
  }

  const flagIdParam = params.get('flagid');
  if (flagIdParam) {
    try {
      const stored = sessionStorage.getItem('admin_detail_flag');
      const row = stored ? JSON.parse(stored) : null;
      if (row && String(row.id) === flagIdParam) {
        loadFlagDetail(row);
        return;
      }
    } catch (_) {}
    // flagid present but no cached row - fall through to flagged tab
    activateTab('flagged', { updateUrl: false });
    return;
  }

  const detailParam = params.get('detail');
  if (detailParam) {
    try {
      const stored = sessionStorage.getItem('admin_detail_user');
      const user = stored ? JSON.parse(stored) : null;
      if (user && (user.proton_pulse_user_id === detailParam || user.client_id === detailParam)) {
        loadUserDetail(user);
        return;
      }
    } catch (_) {}
  }

  // Restore the tab from ?tab= (written by activateTab) so a refresh keeps your place.
  const requestedTab = params.get('tab');
  activateTab(TAB_LOADERS[requestedTab] ? requestedTab : 'users', { updateUrl: false });
}

document.addEventListener('DOMContentLoaded', init);
