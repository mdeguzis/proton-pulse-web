// profile.js — My Account page logic

const SHOW_USERNAME_KEY = 'proton-pulse:show-username-on-reports';

// Filter preferences (used by the View Reports pages)
const HW_GPU_KEY = 'proton-pulse:hw-gpu-vendor';
const HW_OS_KEY  = 'proton-pulse:hw-os';

// Actual hardware spec (auto-fills the web submit-a-report form).
// Keep these prefixed separately so they don't clobber the filter prefs above.
const MYHW_KEYS = {
  cpu:        'proton-pulse:myhw:cpu',
  gpu:        'proton-pulse:myhw:gpu',
  gpuVendor:  'proton-pulse:myhw:gpu-vendor',
  gpuDriver:  'proton-pulse:myhw:gpu-driver',
  ram:        'proton-pulse:myhw:ram',
  vramMb:     'proton-pulse:myhw:vram-mb',
  os:         'proton-pulse:myhw:os',
  osVersion:  'proton-pulse:myhw:os-version',
  kernel:     'proton-pulse:myhw:kernel',
};

// -- Supabase user_systems helpers --
// Keep these next to MYHW_KEYS so everything hardware-related is grouped.
// SUPABASE_URL and SUPABASE_ANON_KEY come from supabase-client.js (loaded
// before this file on profile.html). The plugin writes rows into the
// user_systems table whenever it pushes hardware info; the helpers below
// are what the My Account page uses to list/rename/default/delete them.

function supabaseUserSystemsUrl(query) {
  return `${SUPABASE_URL}/rest/v1/user_systems${query ? '?' + query : ''}`;
}

function supabaseHeaders(session, extra) {
  const h = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  // When signed in, use the user's access token so RLS sees them as authed.
  // Fall back to the anon key for pre-login reads.
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  else h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return Object.assign(h, extra || {});
}

async function listUserSystems(steamId, session) {
  const url = supabaseUserSystemsUrl(
    `steam_id=eq.${encodeURIComponent(steamId)}&order=updated_at.desc`,
  );
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

async function setDefaultSystem(steamId, deviceId, session) {
  // Clear all, then set the chosen one. Two PATCHes; partial unique index
  // protects against a race if another tab is doing the same thing
  const base = supabaseUserSystemsUrl(`steam_id=eq.${encodeURIComponent(steamId)}`);
  const r1 = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r1.ok) throw new Error(`Clear default failed: HTTP ${r1.status}`);
  const specific = supabaseUserSystemsUrl(
    `steam_id=eq.${encodeURIComponent(steamId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r2 = await fetch(specific, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: true }),
  });
  if (!r2.ok) throw new Error(`Set default failed: HTTP ${r2.status}`);
}

async function updateSystemLabel(steamId, deviceId, label, session) {
  const url = supabaseUserSystemsUrl(
    `steam_id=eq.${encodeURIComponent(steamId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ label }),
  });
  if (!r.ok) throw new Error(`Update label failed: HTTP ${r.status}`);
}

async function deleteSystem(steamId, deviceId, session) {
  const url = supabaseUserSystemsUrl(
    `steam_id=eq.${encodeURIComponent(steamId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error(`Delete failed: HTTP ${r.status}`);
}

function getSteamIdFromSession(session) {
  // Steam openid sub is like "https://steamcommunity.com/openid/id/76561198000000000".
  // The Supabase edge function stores it under user_metadata.steam_id (preferred) or
  // provider_id depending on flow. Check both.
  const meta = session?.user?.user_metadata || {};
  return meta.steam_id || meta.provider_id || meta.sub || null;
}

function getShowUsername() {
  return localStorage.getItem(SHOW_USERNAME_KEY) === 'true';
}

function setShowUsername(val) {
  localStorage.setItem(SHOW_USERNAME_KEY, val ? 'true' : 'false');
}

// Parse Steam's "System Information" dump (Steam → Help → System Information).
// ProtonDB's browser extension reads the exact same format, so anything a user
// would send to ProtonDB should work here too. Keep this lenient, a partial
// match is still useful (just fills whatever it finds).
//
// See https://help.steampowered.com/ for the panel that produces this text.
function parseSteamSystemInfo(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;

  // CPU: "CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor"
  const cpu = text.match(/CPU Brand:\s*(.+)/i);
  if (cpu) out.cpu = cpu[1].trim();

  // "Operating System Version:" is a header. The actual value sits on
  // the next line. Windows Steam quotes it ("Arch Linux"), the Linux
  // plugin writes it unquoted with some indent. \s*\n\s* eats the
  // newline and indentation so (.+) captures just the value line.
  const os = text.match(/Operating System Version:\s*\n\s*(.+)/i);
  if (os) {
    // strip the "(64 bit)" tail first so any wrapping quotes end up
    // at the real end of the string, then peel those off
    out.os = os[1].trim()
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/^"(.*)"$/, '$1')
      .trim();
  }

  // Kernel name+version as one blob (matches Linux and SteamOS layouts)
  const kVer  = text.match(/Kernel Version:\s*(.+)/i);
  if (kVer) out.kernel = kVer[1].trim();

  // Video card: Steam prints "Driver:  NVIDIA Corporation NVIDIA GeForce RTX 4070"
  // On the Deck in game mode the plugin may fall back to lspci (no X11),
  // but if even that probe fails the line will literally say "Driver:  Unknown".
  // Treat that as no data so we don't trap a useless string in the form.
  const gpu = text.match(/(?:^|\n)\s*Driver:\s*(.+)/i);
  if (gpu) {
    let g = gpu[1].trim();
    if (!/^unknown$/i.test(g)) {
      g = g.replace(/^(NVIDIA Corporation|Advanced Micro Devices.*?Inc\.|AMD|Intel Corporation|Intel)\s+/i, '');
      out.gpu = g;
    }
  }

  // GPU driver version line shows up separately
  const gpuDrv = text.match(/Driver Version:\s*(.+)/i);
  if (gpuDrv) out.gpuDriver = gpuDrv[1].trim();

  // VRAM: "VRAM: 12282 Mb"
  const vram = text.match(/VRAM:\s*(\d+)\s*Mb/i);
  if (vram) out.vramMb = Number(vram[1]);

  // RAM shows in megs, e.g. "RAM: 32677 Mb". Convert to whole GB for the form
  const ram = text.match(/RAM:\s*(\d+)\s*Mb/i);
  if (ram) {
    const gb = Math.round(Number(ram[1]) / 1024);
    if (gb > 0) out.ram = `${gb} GB`;
  }

  return out;
}

// Infer the gpu-vendor select value from a free-text GPU string.
// Returns 'nvidia' | 'amd' | 'intel' | ''
//
// This is the one bit I left for you — see the TODO. The tricky case is that
// Linux GPU strings can mention multiple vendors at once (e.g. an NVIDIA card
// on an Intel CPU sometimes shows both "Intel" and "NVIDIA" in the sysinfo).
// Decide which takes priority.
function inferGpuVendor(gpuString) {
  // TODO(you): implement this. ~5-10 lines.
  // Suggested approach:
  //   - lowercase the input once
  //   - check for 'nvidia' / 'geforce' / 'quadro' first (most specific)
  //   - then 'amd' / 'radeon' / 'rdna'
  //   - then 'intel' / 'arc' / 'iris' / 'uhd'
  //   - return '' if nothing matches
  // Feel free to tweak the priority order if you think Intel should win when
  // it's named more explicitly than the others.
  return '';
}

// Small helpers pulled out of the page-init IIFE so they can be unit-tested.
// escapeHtml prevents XSS when we drop user-supplied label/device_id into an
// innerHTML template. Keep the char set in sync with the five HTML-unsafe chars
function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Parse an ISO timestamp and format it in the user's locale. new Date() is
// lenient (null -> epoch, '' -> Invalid Date, neither throws), so we guard
// falsy inputs with a dash and fall back to the raw string on unparseable
// input so the UI never shows "Invalid Date"
function formatSystemUpdated(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

// -- My uploaded configs helpers --
//
// The site has two related tables:
//   user_configs = public compatibility reports visible on app.html
//                  (column client_id)
//
// The web client id is a localStorage UUID (proton-pulse:web-client-id) that
// lets us list just the reports this user has submitted, without needing a
// full Supabase auth uid for read-only lookups.

// Same key app.js uses. Duplicated here because app.js isn't loaded on the
// profile page and I didn't want a third file just for one function
const WEB_CLIENT_ID_KEY = 'proton-pulse:web-client-id';

function getWebClientIdProfile() {
  let id = localStorage.getItem(WEB_CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(WEB_CLIENT_ID_KEY, id);
  }
  return id;
}

async function fetchMyUserConfigs(clientId, session) {
  // Your submitted reports, the ones that show up on public game pages
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?client_id=eq.${encodeURIComponent(clientId)}`
    + `&select=id,app_id,title,proton_version,rating,created_at`
    + `&order=created_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

(async function () {
  const signedIn  = document.getElementById('profile-signed-in');
  const signedOut = document.getElementById('profile-signed-out');
  const loginBtn  = document.getElementById('profile-login-btn');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const copyBtn   = document.getElementById('copy-uid-btn');
  const copyLabel = document.getElementById('copy-uid-label');
  const usernameToggle = document.getElementById('show-username-toggle');
  const usernameStatus = document.getElementById('show-username-status');
  const hwGpuSelect    = document.getElementById('hw-gpu-vendor');
  const hwOsInput      = document.getElementById('hw-os');

  // My hardware (spec used to pre-fill the web submit form)
  const myhwInputs = {
    cpu:        document.getElementById('myhw-cpu'),
    gpu:        document.getElementById('myhw-gpu'),
    gpuVendor:  document.getElementById('myhw-gpu-vendor'),
    gpuDriver:  document.getElementById('myhw-gpu-driver'),
    ram:        document.getElementById('myhw-ram'),
    vramMb:     document.getElementById('myhw-vram-mb'),
    os:         document.getElementById('myhw-os'),
    osVersion:  document.getElementById('myhw-os-version'),
    kernel:     document.getElementById('myhw-kernel'),
  };
  const myhwPasteArea  = document.getElementById('myhw-paste');
  const myhwParseBtn   = document.getElementById('myhw-parse-btn');
  const myhwClearBtn   = document.getElementById('myhw-clear-btn');
  const myhwStatus     = document.getElementById('myhw-parse-status');

  function loadMyHardware() {
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = localStorage.getItem(MYHW_KEYS[field]) || '';
    }
  }

  function saveMyHwField(field, rawVal) {
    const val = (rawVal ?? '').toString().trim();
    if (val) localStorage.setItem(MYHW_KEYS[field], val);
    else     localStorage.removeItem(MYHW_KEYS[field]);
  }

  function flashStatus(msg, good) {
    if (!myhwStatus) return;
    myhwStatus.textContent = msg;
    myhwStatus.style.color = good ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { myhwStatus.textContent = ''; }, 2500);
  }

  function showUser(user) {
    const name    = user.user_metadata?.full_name || user.user_metadata?.name || '';
    const email   = user.email || '';
    const uid     = user.id || '';
    const lastAt  = user.last_sign_in_at
      ? new Date(user.last_sign_in_at).toLocaleString()
      : '—';

    document.getElementById('profile-avatar').src              = user.user_metadata?.avatar_url || '';
    document.getElementById('profile-avatar').alt              = name;
    document.getElementById('profile-display-name').textContent = name;
    document.getElementById('profile-user-email').textContent  = email;
    document.getElementById('profile-uid').textContent         = uid;
    document.getElementById('profile-email-detail').textContent = email;
    document.getElementById('profile-last-signin').textContent  = lastAt;
    document.getElementById('profile-steam-username').textContent = name || '—';
    if (usernameToggle) {
      usernameToggle.checked = getShowUsername();
      usernameStatus.textContent = usernameToggle.checked ? 'Shown on reports' : 'Anonymous';
    }
    if (hwGpuSelect) hwGpuSelect.value = localStorage.getItem(HW_GPU_KEY) || '';
    if (hwOsInput)   hwOsInput.value   = localStorage.getItem(HW_OS_KEY)  || '';
    loadMyHardware();

    signedOut.hidden = true;
    signedIn.hidden  = false;
  }

  function showSignedOut() {
    signedIn.hidden  = true;
    signedOut.hidden = false;
  }

  // ── Initial state ──────────────────────────────────────────────────────────
  const session = await SupaAuth.getSession();
  if (session?.user) {
    showUser(session.user);
  } else {
    showSignedOut();
  }

  // ── Stay in sync (e.g. sign-out in another tab) ───────────────────────────
  SupaAuth.onStateChange(({ user }) => {
    if (user) { showUser(user); } else { showSignedOut(); }
  });

  // ── Actions ───────────────────────────────────────────────────────────────
  loginBtn?.addEventListener('click', () => {
    window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
  });

  signoutBtn?.addEventListener('click', async () => {
    await SupaAuth.logout();
    showSignedOut();
  });

  copyBtn?.addEventListener('click', () => {
    const uid = document.getElementById('profile-uid')?.textContent || '';
    if (!uid) return;
    navigator.clipboard?.writeText(uid).then(() => {
      copyBtn.classList.add('copied');
      if (copyLabel) copyLabel.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (copyLabel) copyLabel.textContent = 'Copy';
      }, 1500);
    }).catch(() => {});
  });

  usernameToggle?.addEventListener('change', () => {
    setShowUsername(usernameToggle.checked);
    if (usernameStatus) usernameStatus.textContent = usernameToggle.checked ? 'Shown on reports' : 'Anonymous';
  });

  hwGpuSelect?.addEventListener('change', () => {
    localStorage.setItem(HW_GPU_KEY, hwGpuSelect.value);
  });

  hwOsInput?.addEventListener('change', () => {
    localStorage.setItem(HW_OS_KEY, hwOsInput.value.trim());
  });

  // Save each My-hardware field as it changes
  for (const [field, el] of Object.entries(myhwInputs)) {
    el?.addEventListener('change', () => saveMyHwField(field, el.value));
  }

  // Parse pasted Steam system info and fill the boxes
  myhwParseBtn?.addEventListener('click', () => {
    const text = myhwPasteArea?.value || '';
    if (!text.trim()) { flashStatus('Paste something first', false); return; }

    const parsed = parseSteamSystemInfo(text);
    let filled = 0;

    // Try to infer the vendor when the GPU string parsed out but vendor didn't
    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }

    for (const [field, val] of Object.entries(parsed)) {
      const el = myhwInputs[field];
      if (!el) continue;
      el.value = val;
      saveMyHwField(field, val);
      filled++;
    }

    if (filled === 0) flashStatus('Nothing recognized, check the format', false);
    else              flashStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}`, true);
  });

  // Wipe everything in My hardware including the paste area
  myhwClearBtn?.addEventListener('click', () => {
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = '';
      localStorage.removeItem(MYHW_KEYS[field]);
    }
    if (myhwPasteArea) myhwPasteArea.value = '';
    flashStatus('Cleared', true);
  });

  // ── Your systems (server-side) ────────────────────────────────────────────
  // This is Block 1 on the page, the list of systems the plugin has uploaded
  // into Supabase. Users can rename, mark one as default, or delete. Deletes
  // are soft in the sense that the plugin will just re-create the row next
  // time it pushes hardware info.
  const systemsTable   = document.getElementById('systems-table');
  const systemsTbody   = document.getElementById('systems-tbody');
  const systemsEmpty   = document.getElementById('systems-empty');
  const systemsLoading = document.getElementById('systems-loading');
  const systemsStatus  = document.getElementById('systems-status');
  const systemsRefresh = document.getElementById('systems-refresh-btn');

  // Last list of rows we rendered. Used so the default-toggle handler can
  // grab the sysinfo_text off the row it just starred without a re-fetch
  let systemsCache = [];

  function renderSystems(rows) {
    systemsCache = rows || [];
    systemsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      return;
    }
    systemsEmpty.hidden = true;
    systemsTable.hidden = false;

    // Build rows from the cached list. Label is user-editable so it goes
    // through escapeHtml as the value= attribute
    systemsTbody.innerHTML = rows.map(r => `
      <tr data-device-id="${escapeHtml(r.device_id)}">
        <td>
          <input type="text" class="profile-systems-label-input"
            data-role="label" value="${escapeHtml(r.label || 'Unnamed')}" maxlength="80">
        </td>
        <td>${escapeHtml(formatSystemUpdated(r.updated_at))}</td>
        <td class="col-default">
          <button type="button" class="profile-systems-star ${r.is_default ? 'active' : ''}"
            data-role="default" title="Set as default">${r.is_default ? '*' : 'o'}</button>
        </td>
        <td class="col-delete">
          <button type="button" class="profile-systems-trash" data-role="delete" title="Delete">x</button>
        </td>
      </tr>
    `).join('');
  }

  function showSystemsStatus(msg, ok) {
    if (!systemsStatus) return;
    systemsStatus.textContent = msg;
    systemsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { systemsStatus.textContent = ''; }, 2500);
  }

  async function refreshSystems() {
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) {
      systemsLoading.hidden = true;
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      systemsEmpty.textContent = 'Sign in with Steam to see your uploaded systems.';
      return;
    }
    systemsLoading.hidden = false;
    try {
      const rows = await listUserSystems(steamId, s);
      renderSystems(rows);
    } catch (e) {
      systemsLoading.hidden = true;
      showSystemsStatus(e.message || 'Failed to load systems', false);
    }
  }

  // Ask the user if they want to copy the default system's parsed sysinfo
  // into the Block 2 inputs. Only fires when they opt in via confirm()
  function askReplaceLocalFrom(row) {
    const parsed = parseSteamSystemInfo(row.sysinfo_text || '');
    if (Object.keys(parsed).length === 0) return;
    const label = row.label || 'this system';
    const ok = window.confirm(`Replace your local pre-fill values with "${label}"?`);
    if (!ok) return;
    for (const [field, val] of Object.entries(parsed)) {
      const el = myhwInputs[field];
      if (!el) continue;
      el.value = val;
      saveMyHwField(field, val);
    }
    flashStatus('Local values updated from default system', true);
  }

  async function handleSystemsClick(ev) {
    const tr  = ev.target.closest('tr[data-device-id]');
    const btn = ev.target.closest('button[data-role]');
    if (!tr || !btn) return;
    const deviceId = tr.dataset.deviceId;
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) return;

    try {
      if (btn.dataset.role === 'default') {
        await setDefaultSystem(steamId, deviceId, s);
        await refreshSystems();
        const row = systemsCache.find(r => r.device_id === deviceId);
        if (row) askReplaceLocalFrom(row);
      } else if (btn.dataset.role === 'delete') {
        if (!window.confirm('Delete this system? The plugin will re-create it next time you upload.')) return;
        await deleteSystem(steamId, deviceId, s);
        await refreshSystems();
      }
    } catch (e) {
      showSystemsStatus(e.message || 'Action failed', false);
    }
  }

  // Label saves on blur. Using focusout so it bubbles through the table
  async function handleSystemsLabelBlur(ev) {
    const input = ev.target.closest('input[data-role="label"]');
    if (!input) return;
    const tr = input.closest('tr[data-device-id]');
    const deviceId = tr?.dataset.deviceId;
    if (!deviceId) return;
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) return;
    try {
      await updateSystemLabel(steamId, deviceId, input.value.trim() || 'Unnamed', s);
      showSystemsStatus('Saved', true);
    } catch (e) {
      showSystemsStatus(e.message || 'Save failed', false);
    }
  }

  systemsTable?.addEventListener('click', handleSystemsClick);
  systemsTable?.addEventListener('focusout', handleSystemsLabelBlur);
  systemsRefresh?.addEventListener('click', () => { void refreshSystems(); });

  // Initial fetch so the table populates on page load
  void refreshSystems();

  // First-load convenience: if the user has nothing in Block 2 locally and
  // they've got a default system uploaded, copy its parsed sysinfo into the
  // inputs. Never clobbers existing local values
  async function autoFillFromDefaultIfEmpty() {
    const anyLocal = Object.values(MYHW_KEYS).some(k => localStorage.getItem(k));
    if (anyLocal) return;
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) return;
    try {
      const rows = await listUserSystems(steamId, s);
      const def = rows.find(r => r.is_default);
      if (!def) return;
      const parsed = parseSteamSystemInfo(def.sysinfo_text || '');
      for (const [field, val] of Object.entries(parsed)) {
        const el = myhwInputs[field];
        if (!el) continue;
        el.value = val;
        saveMyHwField(field, val);
      }
      if (Object.keys(parsed).length > 0) {
        flashStatus(`Loaded hardware from "${def.label || 'your system'}"`, true);
      }
    } catch {
      // non-fatal, just leave Block 2 empty
    }
  }

  void autoFillFromDefaultIfEmpty();

  // ── My uploaded reports ───────────────────────────────────────────────────
  // List the user's submitted reports from user_configs. Uploading from the
  // plugin publishes directly, so there's no draft vs. published split to
  // represent here, just a flat list of what you've put out there
  const myConfigsTable    = document.getElementById('my-configs-table');
  const myConfigsTbody    = document.getElementById('my-configs-tbody');
  const myConfigsEmpty    = document.getElementById('my-configs-empty');
  const myConfigsLoading  = document.getElementById('my-configs-loading');
  const myConfigsStatus   = document.getElementById('my-configs-status');
  const myConfigsRefresh  = document.getElementById('my-configs-refresh-btn');

  function showMyConfigsStatus(msg, ok) {
    if (!myConfigsStatus) return;
    myConfigsStatus.textContent = msg;
    myConfigsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { myConfigsStatus.textContent = ''; }, 3000);
  }

  function renderMyConfigs(rows) {
    myConfigsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      myConfigsTable.hidden = true;
      myConfigsEmpty.hidden = false;
      return;
    }
    myConfigsEmpty.hidden = true;
    myConfigsTable.hidden = false;

    myConfigsTbody.innerHTML = rows.map(row => {
      const appLink = `app.html#/app/${encodeURIComponent(row.app_id)}`;
      const name = row.title || `App ${row.app_id}`;
      return `
        <tr data-app-id="${escapeHtml(String(row.app_id))}">
          <td>
            <a href="${escapeHtml(appLink)}" class="profile-configs-game-link">${escapeHtml(name)}</a>
            <div class="profile-configs-appid">App ${escapeHtml(String(row.app_id))}</div>
          </td>
          <td>${escapeHtml(row.rating || '')}</td>
          <td>${escapeHtml(formatSystemUpdated(row.created_at))}</td>
          <td class="col-action"><a class="profile-configs-view-link" href="${escapeHtml(appLink)}">View</a></td>
        </tr>`;
    }).join('');
  }

  async function refreshMyConfigs() {
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      myConfigsLoading.hidden = true;
      myConfigsTable.hidden   = true;
      myConfigsEmpty.hidden   = false;
      myConfigsEmpty.textContent = 'Sign in with Steam to see your uploaded reports.';
      return;
    }
    myConfigsLoading.hidden = false;
    myConfigsEmpty.hidden   = true;
    try {
      const cid  = getWebClientIdProfile();
      const rows = await fetchMyUserConfigs(cid, s);
      renderMyConfigs(rows);
    } catch (e) {
      myConfigsLoading.hidden = true;
      showMyConfigsStatus(e.message || 'Failed to load', false);
    }
  }

  myConfigsRefresh?.addEventListener('click', () => { void refreshMyConfigs(); });

  void refreshMyConfigs();

  // ── Topbar auth chip ──────────────────────────────────────────────────────
  (function() {
    const loginBtn  = document.getElementById('google-login-btn');
    const userMenu  = document.getElementById('google-user-menu');
    const avatarEl  = document.getElementById('google-avatar');
    const nameEl    = document.getElementById('google-username');
    const menuBtn   = document.getElementById('google-menu-btn');
    const dropdown  = document.getElementById('google-dropdown');
    const logoutBtn = document.getElementById('google-logout-btn');

    SupaAuth.onStateChange(({ user }) => {
      if (user) {
        loginBtn.hidden    = true;
        userMenu.hidden    = false;
        avatarEl.src       = user.user_metadata?.avatar_url || '';
        avatarEl.alt       = user.user_metadata?.name || user.email || '';
        nameEl.textContent = user.user_metadata?.name || user.email || '';
      } else {
        loginBtn.hidden = false;
        userMenu.hidden = true;
        if (dropdown) dropdown.classList.remove('open');
      }
    });

    loginBtn?.addEventListener('click', () => {
      window.location.href = SupaAuth.buildLoginPageUrl(window.location.href);
    });
    logoutBtn?.addEventListener('click', () => { dropdown.classList.remove('open'); SupaAuth.logout(); });
    userMenu?.addEventListener('click', e => {
      if (dropdown.contains(e.target)) return;
      dropdown.classList.toggle('open');
    });

    const chip = document.getElementById('gh-auth-chip');
    document.addEventListener('click', e => {
      if (chip && chip.contains(e.target)) return;
      if (dropdown) dropdown.classList.remove('open');
    });
  })();

  // ── Sidebar toggle ────────────────────────────────────────────────────────
  const toggle  = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  toggle?.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });
})();
