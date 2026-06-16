import { SupaAuth, SUPABASE_URL } from './config.js?v=ffed3d84';
import { supabaseHeaders } from './utils.js?v=86489fcb';
import { fetchFlaggedReports, reinstateReport, deleteReport } from './api/flagged.js?v=55433ab8';
import { renderFlagged } from './components/flagged.js?v=b9c9f230';
import { fetchBannedUsers, banUser, unbanUser } from './api/banned.js?v=aa9b6b53';
import { renderBanned } from './components/banned.js?v=45d01d17';
import { fetchAllUsers } from './api/users.js?v=718eb921';
import { renderUsers } from './components/users.js?v=996b2026';
import { fetchAdmins, addAdmin, removeAdmin, updateAdminRole } from './api/admins.js?v=637a90b4';
import { renderAdmins } from './components/admins.js?v=0956f8c4';
import { fetchBannedPhrases, addBannedPhrase, removeBannedPhrase, toggleBannedPhrase } from './api/phrases.js?v=ca024bd3';
import { renderPhrases } from './components/phrases.js?v=79051c31';
import { loadWordlist, checkAgainstWordlist } from './api/wordlist.js?v=51c55965';
import { fetchUserReports, fetchUserActivity } from './api/userDetail.js?v=916aedfc';
import { renderUserDetail } from './components/userDetail.js?v=7025c758';
import { fetchAnalytics } from './api/analytics.js?v=1b3f4599';
import { renderAnalytics } from './components/analytics.js?v=7d29939b';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentSession = null;
let flaggedRows = [];
let bannedRows = [];
let sortField = 'flagged_at';
let sortDir = 'desc';

// ---------------------------------------------------------------------------
// Supabase queries
// ---------------------------------------------------------------------------

async function isAdmin(session) {
  if (!session?.user?.id) return false;
  try {
    const url = `${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${encodeURIComponent(session.user.id)}&select=proton_pulse_user_id&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders(session) });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Load sections
// ---------------------------------------------------------------------------

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
    flaggedRows = await fetchFlaggedReports(currentSession, { search, type, dateFrom, dateTo, sortField, sortDir });
    renderFlagged(flaggedRows);
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
  loading.hidden = false;
  err.hidden = true;
  try {
    const { rows, counts } = await fetchAllUsers(currentSession, { search });
    renderUsers(rows, { currentUserId: currentSession?.user?.id, counts });
  } catch (e) {
    loading.hidden = true;
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function loadAdmins() {
  try {
    const rows = await fetchAdmins(currentSession);
    renderAdmins(rows);
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
    const [reports, authEvents] = await Promise.all([
      fetchUserReports(currentSession, {
        userId: user.proton_pulse_user_id || null,
        clientId: user.client_id || null,
      }),
      fetchUserActivity(currentSession, { userId: user.proton_pulse_user_id || null }),
    ]);
    renderUserDetail(user, reports, authEvents, {
      session: currentSession,
      currentUserId: currentSession?.user?.id,
    });
  } catch (e) {
    content.innerHTML = `<div class="admin-error">${e.message}</div>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" type="button" data-action="back-to-users" style="margin-top:10px">&#8592; Back to users</button>`;
  }
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
}

// Maps each tab to its data loader so tab clicks and ?tab= restore share one path.
const TAB_LOADERS = {
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
  if (!TAB_LOADERS[tabName]) tabName = 'users';
  switchTab(tabName);
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabName);
    url.searchParams.delete('detail');
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
  document.getElementById('flagged-refresh-btn').addEventListener('click', loadFlagged);
  document.getElementById('banned-refresh-btn').addEventListener('click', loadBanned);
  document.getElementById('users-refresh-btn').addEventListener('click', loadUsers);

  // Search inputs - live filter on enter
  document.getElementById('flagged-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadFlagged(); });
  document.getElementById('flagged-type').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-from').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-to').addEventListener('change', loadFlagged);
  document.getElementById('banned-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadBanned(); });
  document.getElementById('users-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadUsers(); });

  // Flagged table actions (delegated)
  document.getElementById('flagged-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'reinstate') {
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await reinstateReport(currentSession, id);
        btn.closest('tr').remove();
        flaggedRows = flaggedRows.filter(r => String(r.id) !== id);
        if (!flaggedRows.length) {
          document.getElementById('flagged-empty').hidden = false;
          document.getElementById('flagged-table').hidden = true;
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Reinstate';
        alert(`Error: ${err.message}`);
      }
    }

    if (action === 'delete') {
      if (!confirm('Delete this report permanently?')) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await deleteReport(currentSession, id);
        btn.closest('tr').remove();
        flaggedRows = flaggedRows.filter(r => String(r.id) !== id);
        if (!flaggedRows.length) {
          document.getElementById('flagged-empty').hidden = false;
          document.getElementById('flagged-table').hidden = true;
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Delete';
        alert(`Error: ${err.message}`);
      }
    }

    if (action === 'ban') {
      openBanModal(btn.dataset.userId, btn.dataset.clientId, btn.dataset.username);
    }
  });

  // Users table actions (delegated)
  document.getElementById('users-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'ban-user') {
      openBanModal(btn.dataset.userid, null, btn.dataset.username);
    }
    if (action === 'unban-user') {
      if (!confirm('Unban this user and restore their reports?')) return;
      btn.disabled = true;
      btn.textContent = '...';
      console.log('[unban-user] banId:', btn.dataset.banId, 'userid:', btn.dataset.userid);
      try {
        await unbanUser(currentSession, btn.dataset.banId, { protonPulseUserId: btn.dataset.userid, clientId: btn.dataset.clientid });
        loadUsers();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Unban';
        alert(`Error: ${err.message}`);
      }
    }
    if (action === 'view-user-detail') {
      let user;
      try {
        user = JSON.parse(btn.dataset.userobj);
      } catch (_) {
        alert('Could not parse user data.');
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
      activateTab('users');
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
        activateTab('users');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Unban';
        alert(`Error: ${err.message}`);
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
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Unban';
      alert(`Error: ${err.message}`);
    }
  });

  // Ban modal
  document.getElementById('ban-confirm-btn').addEventListener('click', async () => {
    if (!pendingBan) return;
    const reason = document.getElementById('ban-reason-input').value.trim();
    console.log('[ban-confirm] pendingBan:', pendingBan, 'reason:', reason);
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
      // Refresh the users list so the newly banned user shows Unban.
      loadUsers();
    } catch (err) {
      alert(`Error: ${err.message}`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Ban';
    }
  });

  document.getElementById('ban-cancel-btn').addEventListener('click', closeBanModal);
  document.getElementById('ban-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBanModal();
  });

  // Browser back button / swipe back from detail screen.
  window.addEventListener('popstate', e => {
    const detailVisible = !document.getElementById('tab-user-detail').hidden;
    if (detailVisible) activateTab('users');
  });

  // Add admin form
  document.getElementById('add-admin-btn').addEventListener('click', async () => {
    const uuid     = document.getElementById('new-admin-uuid').value.trim();
    const username = document.getElementById('new-admin-username').value.trim();
    const role     = document.getElementById('new-admin-role').value;
    const status   = document.getElementById('add-admin-status');
    if (!uuid || !username) { status.textContent = 'UUID and username are required.'; status.style.color = 'var(--red)'; return; }
    try {
      await addAdmin(currentSession, { uuid, username, role });
      status.textContent = `Added ${username}.`;
      status.style.color = 'var(--green)';
      document.getElementById('new-admin-uuid').value = '';
      document.getElementById('new-admin-username').value = '';
      loadAdmins();
    } catch (e) {
      status.textContent = e.message;
      status.style.color = 'var(--red)';
    }
  });

  // Admins table: remove + role change (delegated)
  document.getElementById('admins-tbody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="remove-admin"]');
    if (!btn) return;
    if (!confirm(`Remove ${btn.dataset.name} as admin?`)) return;
    btn.disabled = true; btn.textContent = '...';
    try {
      await removeAdmin(currentSession, btn.dataset.uuid);
      btn.closest('tr').remove();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Remove';
      alert(`Error: ${err.message}`);
    }
  });

  document.getElementById('admins-tbody').addEventListener('change', async e => {
    const sel = e.target.closest('[data-action="change-role"]');
    if (!sel) return;
    const origVal = sel.dataset.currentRole || sel.value;
    try {
      sel.dataset.currentRole = sel.value;
      await updateAdminRole(currentSession, sel.dataset.uuid, sel.value);
    } catch (err) {
      sel.value = origVal;
      alert(`Error: ${err.message}`);
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
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Remove';
        alert(`Error: ${err.message}`);
      }
    }

    if (action === 'toggle-phrase') {
      const enabled = btn.dataset.enabled !== 'true';
      btn.disabled = true; btn.textContent = '...';
      try {
        await toggleBannedPhrase(currentSession, id, enabled);
        loadPhrases();
      } catch (err) {
        btn.disabled = false;
        alert(`Error: ${err.message}`);
      }
    }
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

  const admin = await isAdmin(session);
  if (!admin) {
    notAuth.hidden = false;
    return;
  }

  panel.hidden = false;
  wireEvents();

  const params = new URLSearchParams(window.location.search);
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
