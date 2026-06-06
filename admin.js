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
  const url = `${SUPABASE_URL}/rest/v1/admins?select=proton_pulse_user_id,steam_username,role,added_at&order=added_at.asc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch admins failed: ${res.status}`);
  return res.json();
}

async function addAdmin(session, { uuid, username, role }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins`, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ proton_pulse_user_id: uuid, steam_username: username, role }),
  });
  if (!res.ok) throw new Error(`Add admin failed: ${res.status} ${await res.text()}`);
}

async function removeAdmin(session, uuid) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${uuid}`, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Remove admin failed: ${res.status}`);
}

async function updateAdminRole(session, uuid, role) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?proton_pulse_user_id=eq.${uuid}`, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`Update role failed: ${res.status}`);
}

async function fetchBannedPhrases(session) {
  const url = `${SUPABASE_URL}/rest/v1/banned_phrases?select=*&order=created_at.desc`;
  const res = await fetch(url, { headers: supabaseHeaders(session) });
  if (!res.ok) throw new Error(`Fetch phrases failed: ${res.status}`);
  return res.json();
}

async function addBannedPhrase(session, { pattern, is_regex, description }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases`, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ pattern, is_regex: !!is_regex, description: description || null, created_by: session.user.id }),
  });
  if (!res.ok) throw new Error(`Add phrase failed: ${res.status} ${await res.text()}`);
}

async function removeBannedPhrase(session, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases?id=eq.${id}`, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`Remove phrase failed: ${res.status}`);
}

async function toggleBannedPhrase(session, id, enabled) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/banned_phrases?id=eq.${id}`, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`Toggle phrase failed: ${res.status}`);
}

async function fetchAllUsers(session, { search } = {}) {
  async function fetchAllRows(table, select) {
    const limit = 1000;
    let offset = 0, rows = [];
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=${limit}&offset=${offset}&order=updated_at.desc`;
      const res = await fetch(url, { headers: supabaseHeaders(session) });
      if (!res.ok) throw new Error(`Fetch ${table} failed: ${res.status}`);
      const batch = await res.json();
      rows.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return rows;
  }

  // Pull from both tables — user_configs = submitted reports, user_proton_configs = cloud configs.
  const [configs, protonConfigs] = await Promise.all([
    fetchAllRows('user_configs', 'proton_pulse_user_id,client_id,updated_at'),
    fetchAllRows('user_proton_configs', 'proton_pulse_user_id,installation_id,updated_at'),
  ]);

  // Aggregate per unique identity across both tables.
  const byUser = new Map();

  function merge(protonPulseUserId, clientId, updatedAt, isReport) {
    const key = protonPulseUserId || clientId;
    if (!key) return;
    if (!byUser.has(key)) {
      byUser.set(key, {
        proton_pulse_user_id: protonPulseUserId || null,
        client_id: clientId || null,
        report_count: 0,
        last_active: updatedAt,
        display_name: null,
      });
    }
    const u = byUser.get(key);
    if (isReport) u.report_count++;
    if (updatedAt > u.last_active) u.last_active = updatedAt;
    if (!u.proton_pulse_user_id && protonPulseUserId) u.proton_pulse_user_id = protonPulseUserId;
    if (!u.client_id && clientId) u.client_id = clientId;
  }

  for (const r of configs) merge(r.proton_pulse_user_id, r.client_id, r.updated_at, true);
  for (const r of protonConfigs) merge(r.proton_pulse_user_id, r.installation_id, r.updated_at, false);

  // Enrich with display names from author_avatars.
  const uuids = [...byUser.values()].map(u => u.proton_pulse_user_id).filter(Boolean);
  if (uuids.length) {
    const avatarUrl = `${SUPABASE_URL}/rest/v1/author_avatars?select=proton_pulse_user_id,display_name&proton_pulse_user_id=in.(${uuids.join(',')})`;
    const avatarRes = await fetch(avatarUrl, { headers: supabaseHeaders(session) });
    if (avatarRes.ok) {
      const avatars = await avatarRes.json();
      for (const a of avatars) {
        const u = byUser.get(a.proton_pulse_user_id);
        if (u) u.display_name = a.display_name || null;
      }
    }
  }

  // Also check admins table for display names.
  const adminsRes = await fetch(`${SUPABASE_URL}/rest/v1/admins?select=proton_pulse_user_id,steam_username`, { headers: supabaseHeaders(session) });
  if (adminsRes.ok) {
    const admins = await adminsRes.json();
    for (const a of admins) {
      const u = byUser.get(a.proton_pulse_user_id);
      if (u && !u.display_name) u.display_name = a.steam_username;
    }
  }

  let rows = [...byUser.values()].sort((a, b) => (b.last_active || '') > (a.last_active || '') ? 1 : -1);

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      (r.display_name || '').toLowerCase().includes(q) ||
      (r.proton_pulse_user_id || '').toLowerCase().includes(q) ||
      (r.client_id || '').toLowerCase().includes(q)
    );
  }

  return rows;
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

function renderUsers(rows) {
  const loading = document.getElementById('users-loading');
  const empty   = document.getElementById('users-empty');
  const table   = document.getElementById('users-table');
  const tbody   = document.getElementById('users-tbody');
  const err     = document.getElementById('users-error');

  loading.hidden = true;
  err.hidden = true;

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
    return `<tr>
      <td>${name}</td>
      <td><code class="admin-uid">${uid || '—'}</code></td>
      <td><code class="admin-uid">${cid || '—'}</code></td>
      <td>${r.report_count}</td>
      <td>${lastActive}</td>
      <td>
        <button class="admin-btn admin-btn--danger admin-btn--sm"
          data-action="ban-user" data-userid="${uid}" data-username="${name}">Ban</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPhrases(rows) {
  const loading = document.getElementById('phrases-loading');
  const empty   = document.getElementById('phrases-empty');
  const table   = document.getElementById('phrases-table');
  const tbody   = document.getElementById('phrases-tbody');
  const err     = document.getElementById('phrases-error');

  loading.hidden = true;
  err.hidden = true;

  if (!rows.length) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  tbody.innerHTML = rows.map(r => {
    const id      = escapeHtml(String(r.id));
    const pattern = escapeHtml(r.pattern);
    const typeTag = r.is_regex
      ? '<span class="admin-badge admin-badge--regex">Regex</span>'
      : '<span class="admin-badge">Literal</span>';
    const desc    = escapeHtml(r.description || '—');
    const added   = escapeHtml(fmtDate(r.created_at));
    const toggleLabel = r.enabled ? 'Disable' : 'Enable';
    const toggleClass = r.enabled ? 'admin-btn--warn' : 'admin-btn--ok';
    return `<tr data-phrase-id="${id}"${r.enabled ? '' : ' class="admin-row--disabled"'}>
      <td><code class="admin-pattern">${pattern}</code></td>
      <td>${typeTag}</td>
      <td>${desc}</td>
      <td>${added}</td>
      <td>
        <div class="admin-actions">
          <button class="admin-btn admin-btn--sm ${toggleClass}" data-action="toggle-phrase" data-id="${id}" data-enabled="${r.enabled}">${toggleLabel}</button>
          <button class="admin-btn admin-btn--sm admin-btn--danger" data-action="remove-phrase" data-id="${id}">Remove</button>
        </div>
      </td>
    </tr>`;
  }).join('');
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

async function loadUsers() {
  const loading = document.getElementById('users-loading');
  const err     = document.getElementById('users-error');
  const search  = document.getElementById('users-search')?.value.trim() || '';
  loading.hidden = false;
  err.hidden = true;
  try {
    const rows = await fetchAllUsers(currentSession, { search });
    renderUsers(rows);
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
      else if (tab === 'users') loadUsers();
      else if (tab === 'admins') loadAdmins();
      else if (tab === 'phrases') loadPhrases();
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
  document.getElementById('users-tbody').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="ban-user"]');
    if (!btn) return;
    openBanModal(btn.dataset.userid, null, btn.dataset.username);
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
      await addBannedPhrase(currentSession, { pattern, is_regex, description });
      status.textContent = 'Phrase added.';
      status.style.color = 'var(--green)';
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
  loadFlagged();
}

document.addEventListener('DOMContentLoaded', init);
