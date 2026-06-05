// SUPABASE_URL, SUPABASE_ANON_KEY, SupaAuth come from supabase-client.js

function supabaseHeaders(session, extra = {}) {
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...extra };
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  else h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return h;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function friendlyReason(raw) {
  if (!raw) return '—';
  if (raw.startsWith('wordlist:')) return raw.replace('wordlist:', 'Wordlist: ');
  if (raw.startsWith('openai:')) return raw.replace('openai:', 'OpenAI: ');
  if (raw.startsWith('admin:')) return raw.replace('admin:', 'Admin: ');
  return raw;
}

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
  const url = `${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${encodeURIComponent(session.user.id)}&select=proton_pulse_user_id&limit=1`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function fetchFlaggedReports(session, { search, type, dateFrom, dateTo } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?is_flagged=eq.true`
    + `&select=id,app_id,title,proton_pulse_user_id,client_id,flagged_reason,flagged_at,is_hidden`
    + `&order=${encodeURIComponent(sortField)}.${sortDir}`;

  if (dateFrom) url += `&flagged_at=gte.${encodeURIComponent(new Date(dateFrom).toISOString())}`;
  if (dateTo) {
    const end = new Date(dateTo);
    end.setDate(end.getDate() + 1);
    url += `&flagged_at=lte.${encodeURIComponent(end.toISOString())}`;
  }
  if (type) url += `&flagged_reason=like.${encodeURIComponent(type + ':*')}`;

  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch flagged failed: ${res.status}`);
  let rows = await res.json();

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.flagged_reason || '').toLowerCase().includes(q)
    );
  }

  // Batch-fetch author display names from author_avatars.
  const userIds = [...new Set(rows.map(r => r.proton_pulse_user_id).filter(Boolean))];
  const avatarMap = {};
  if (userIds.length) {
    const ids = userIds.map(id => `"${id}"`).join(',');
    const avUrl = `${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=in.(${encodeURIComponent(ids)})&select=proton_pulse_user_id,display_name,steam_id`;
    const avRes = await fetch(avUrl, { headers: supabaseHeaders(session) });
    if (avRes.ok) {
      const avRows = await avRes.json();
      for (const av of avRows) avatarMap[av.proton_pulse_user_id] = av;
    }
  }

  return rows.map(r => ({ ...r, _author: avatarMap[r.proton_pulse_user_id] ?? null }));
}

async function fetchBannedUsers(session, { search } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/banned_users?select=id,proton_pulse_user_id,client_id,steam_username,banned_reason,banned_at&order=banned_at.desc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch banned failed: ${res.status}`);
  let rows = await res.json();
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r => (r.steam_username || '').toLowerCase().includes(q));
  }
  return rows;
}

async function fetchAdmins(session) {
  const url = `${SUPABASE_URL}/rest/v1/admins?select=proton_pulse_user_id,steam_username,added_at&order=added_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch admins failed: ${res.status}`);
  return res.json();
}

async function reinstateReport(session, id) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_flagged: false, is_hidden: false, flagged_reason: null, flagged_at: null }),
  });
  if (!res.ok) throw new Error(`Reinstate failed: ${res.status}`);
}

async function deleteReport(session, id) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

async function banUser(session, { protonPulseUserId, clientId, steamUsername, reason }) {
  // Insert ban record.
  const banUrl = `${SUPABASE_URL}/rest/v1/banned_users`;
  const banRes = await fetch(banUrl, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      proton_pulse_user_id: protonPulseUserId || null,
      client_id: clientId || null,
      steam_username: steamUsername || null,
      banned_reason: reason || null,
      banned_by: session.user.id,
    }),
  });
  if (!banRes.ok) throw new Error(`Ban insert failed: ${banRes.status}`);

  // Hide all their reports.
  const filters = [];
  if (protonPulseUserId) filters.push(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  else if (clientId) filters.push(`client_id=eq.${encodeURIComponent(clientId)}`);
  if (!filters.length) return;

  const hideUrl = `${SUPABASE_URL}/rest/v1/user_configs?${filters.join('&')}`;
  const hideRes = await fetch(hideUrl, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_hidden: true, is_flagged: true, flagged_reason: 'admin:banned' }),
  });
  if (!hideRes.ok) throw new Error(`Hide reports failed: ${hideRes.status}`);
}

async function unbanUser(session, banId, { protonPulseUserId, clientId } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/banned_users?id=eq.${banId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Unban failed: ${res.status}`);

  // Restore reports that were hidden solely due to the ban.
  const filters = [];
  if (protonPulseUserId) filters.push(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  else if (clientId) filters.push(`client_id=eq.${encodeURIComponent(clientId)}`);
  if (!filters.length) return;

  const restoreUrl = `${SUPABASE_URL}/rest/v1/user_configs?${filters.join('&')}&flagged_reason=eq.admin%3Abanned`;
  const restoreRes = await fetch(restoreUrl, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_hidden: false, is_flagged: false, flagged_reason: null, flagged_at: null }),
  });
  if (!restoreRes.ok) throw new Error(`Restore reports failed: ${restoreRes.status}`);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderFlagged(rows) {
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

function renderBanned(rows) {
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
    const bannedAt = escapeHtml(fmtDate(r.banned_at));
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

function renderAdmins(rows) {
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

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.steam_username)}</td>
      <td>${escapeHtml(fmtDate(r.added_at))}</td>
    </tr>`).join('');
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
    flaggedRows = await fetchFlaggedReports(currentSession, { search, type, dateFrom, dateTo });
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
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('admin-tab--active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.admin-section').forEach(sec => {
    sec.hidden = sec.id !== `tab-${tabName}`;
  });
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

function wireEvents() {
  // Tab buttons
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
      if (tab === 'flagged') loadFlagged();
      else if (tab === 'banned') loadBanned();
      else if (tab === 'admins') loadAdmins();
    });
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

  // Search inputs - live filter on enter
  document.getElementById('flagged-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadFlagged(); });
  document.getElementById('flagged-type').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-from').addEventListener('change', loadFlagged);
  document.getElementById('flagged-date-to').addEventListener('change', loadFlagged);
  document.getElementById('banned-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadBanned(); });

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
      loadFlagged();
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
  loadFlagged();
}

document.addEventListener('DOMContentLoaded', init);
