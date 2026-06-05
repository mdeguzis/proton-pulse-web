// profile.js — My Account page logic

// localhost dev mode: show mock profile data so the page is previewable
const IS_LOCAL_DEV = /^localhost(:\d+)?$/.test(window.location.host);

const SHOW_USERNAME_KEY = 'proton-pulse:show-username-on-reports';

// Filter preferences (used by the View Reports pages)
const HW_GPU_KEY = 'proton-pulse:hw-gpu-vendor';
const HW_OS_KEY  = 'proton-pulse:hw-os';
const CONFIG_TYPE_KEY = 'proton-pulse:config-type';

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
const MYHW_SOURCE_META_KEY = 'proton-pulse:myhw:source-meta';

// Per-field origin tracking. This is separate from the single source-meta
// blob so the UI can label each input individually, e.g. "CPU from default
// system" vs "GPU manually edited". Values: 'default-system' | 'steam-paste'
// | 'manual'. Missing entry = never set, show nothing.
const MYHW_FIELD_ORIGINS_KEY = 'proton-pulse:myhw:field-origins';

// Short, human-readable caption per origin. Keep these terse because they
// render inline next to every field label
const MYHW_ORIGIN_LABELS = {
  'default-system': 'from default system',
  'steam-paste':    'from pasted sysinfo',
  'manual':         'edited',
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

async function listUserSystems(protonPulseUserId, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&order=updated_at.desc`,
  );
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

async function setDefaultSystem(protonPulseUserId, deviceId, session) {
  // Clear all, then set the chosen one. Two PATCHes; partial unique index
  // protects against a race if another tab is doing the same thing
  const base = supabaseUserSystemsUrl(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  const r1 = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r1.ok) throw new Error(`Clear default failed: HTTP ${r1.status}`);
  const specific = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r2 = await fetch(specific, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: true }),
  });
  if (!r2.ok) throw new Error(`Set default failed: HTTP ${r2.status}`);
}

// Turn OFF the default flag across every row for this user. We don't target a
// single device here because "no default" is the desired end state and going
// row-by-row would risk a brief window where two rows are default at once
async function clearDefaultSystem(protonPulseUserId, session) {
  const base = supabaseUserSystemsUrl(`proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`);
  const r = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r.ok) throw new Error(`Clear default failed: HTTP ${r.status}`);
}

async function updateSystemLabel(protonPulseUserId, deviceId, label, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
  );
  const r = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ label }),
  });
  if (!r.ok) throw new Error(`Update label failed: HTTP ${r.status}`);
}

async function deleteSystem(protonPulseUserId, deviceId, session) {
  const url = supabaseUserSystemsUrl(
    `proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
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

function getProtonPulseUserIdFromSession(session) {
  return session?.user?.id || null;
}

// localStorage is the fast local read; Supabase user_metadata is the
// authoritative cross-device source. getShowUsername reads local only;
// showUser() syncs the authoritative value down on sign-in.
function getShowUsername() {
  // Default to true for signed-in Pulse accounts: if the user took the
  // step of linking their Steam account, the assumption is they want their
  // username visible on reports. They can opt out via the toggle, which
  // sets the key to the literal string 'false'.
  const v = localStorage.getItem(SHOW_USERNAME_KEY);
  if (v === null) return true;
  return v === 'true';
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
// Treat a literal "Unknown" (case-insensitive) as "no data". The Deck's
// sysinfo generator places this when it can't probe, and letting it slip
// through makes the prefill boxes look populated when they really aren't
function cleanUnknown(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return /^unknown$/i.test(t) ? '' : t;
}

function parseSteamSystemInfo(text) {
  const out = {};
  if (!text || typeof text !== 'string') return out;

  // CPU: "CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor"
  const cpu = text.match(/CPU Brand:\s*(.+)/i);
  if (cpu) {
    const v = cleanUnknown(cpu[1]);
    if (v) out.cpu = v;
  }

  // "Operating System Version:" is a header. The actual value sits on
  // the next line. Windows Steam quotes it ("Arch Linux"), the Linux
  // plugin writes it unquoted with some indent. \s*\n\s* eats the
  // newline and indentation so (.+) captures just the value line.
  const os = text.match(/Operating System Version:\s*\n\s*(.+)/i);
  if (os) {
    // strip the "(64 bit)" tail first so any wrapping quotes end up
    // at the real end of the string, then peel those off
    const v = cleanUnknown(os[1].trim()
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/^"(.*)"$/, '$1'));
    if (v) out.os = v;
  }

  // Board Manufacturer / Model / Form Factor from the "Computer Information:"
  // block. These survive when everything else (glxinfo, cpuinfo) fails and
  // are the cleanest way to recognize a Steam Deck (Valve Jupiter = LCD,
  // Valve Galileo = OLED).
  const vendorM = text.match(/Manufacturer:\s*(.+)/i);
  if (vendorM) {
    const v = cleanUnknown(vendorM[1]);
    if (v) out.manufacturer = v;
  }
  const modelM  = text.match(/Model:\s*(.+)/i);
  if (modelM) {
    const v = cleanUnknown(modelM[1]);
    if (v) out.model = v;
  }

  // Kernel name+version as one blob (matches Linux and SteamOS layouts)
  const kVer  = text.match(/Kernel Version:\s*(.+)/i);
  if (kVer) {
    const v = cleanUnknown(kVer[1]);
    if (v) out.kernel = v;
  }

  // Video card: Steam prints "Driver:  NVIDIA Corporation NVIDIA GeForce RTX 4070"
  // On the Deck in game mode the plugin may fall back to lspci (no X11),
  // but if even that probe fails the line will literally say "Driver:  Unknown".
  // Treat that as no data so we don't trap a useless string in the form.
  const gpu = text.match(/(?:^|\n)\s*Driver:\s*(.+)/i);
  if (gpu) {
    let g = gpu[1].trim();
    if (!/^unknown$/i.test(g)) {
      // Two-pass strip: drop the corp prefix first, then peel a trailing
      // "NVIDIA " that often doubles up in Steam's output, e.g.
      // "NVIDIA Corporation NVIDIA GeForce RTX 4070" -> "GeForce RTX 4070"
      g = g
        .replace(/^(NVIDIA Corporation|Advanced Micro Devices.*?Inc\.|AMD|Intel Corporation|Intel)\s+/i, '')
        .replace(/^NVIDIA\s+/i, '');
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
  const s = (gpuString || '').toString().toLowerCase();
  if (!s) return '';
  if (/(nvidia|geforce|quadro)/.test(s)) return 'nvidia';
  if (/(amd|radeon|rdna|rx\s*\d|vega)/.test(s)) return 'amd';
  if (/(intel|arc|iris|uhd|xe\b)/.test(s)) return 'intel';
  return '';
}

function parseUploadedSystem(row) {
  const parsed = parseSteamSystemInfo(row?.sysinfo_text || '');
  if (parsed.gpu && !parsed.gpuVendor) {
    parsed.gpuVendor = inferGpuVendor(parsed.gpu);
  }
  return parsed;
}

function isGenericSystemLabel(label) {
  const s = (label || '').toString().trim().toLowerCase();
  return !s
    || s === 'unknown'
    || s === 'unknown system'
    || s === 'unnamed'
    || s === 'system'
    || s === 'uploaded system';
}

// Build a short label. Priority order (matches the plugin's generateLabel so
// the plugin-stored label and the self-heal path land in the same place):
//   1) Steam Deck when board or APU identifies it
//   2) "{OS}-{VENDOR}-{GPU_MODEL}" as a generic hardware-derived fallback
//   3) 'Uploaded system' when there's literally nothing to go on
function inferSystemLabel(rowOrParsed) {
  const parsed = rowOrParsed?.sysinfo_text !== undefined ? parseUploadedSystem(rowOrParsed) : (rowOrParsed || {});

  // Deck detection — board first, then chipset hints in the raw text. Board
  // match gets us LCD vs OLED, chipset-only falls back to the generic label.
  const manufacturer = (parsed.manufacturer || '').trim();
  const model        = (parsed.model || '').trim();
  const deckByBoard  = /^valve$/i.test(manufacturer) && /^(jupiter|galileo)$/i.test(model);
  const combined     = [parsed.cpu, parsed.gpu, parsed.os, parsed.kernel].filter(Boolean).join(' ').toLowerCase();
  const deckByChips  = /vangogh|amd custom apu 0405/.test(combined);
  if (deckByBoard || deckByChips) {
    if (/galileo/i.test(model)) return 'Steam Deck OLED';
    if (/jupiter/i.test(model)) return 'Steam Deck LCD';
    return 'Steam Deck';
  }

  // Dash-joined fallback: OS-VENDOR-GPU. Each piece is optional so a machine
  // with only a parsed OS still gets a useful label (and no stray dashes).
  const osBase = (parsed.os || '').trim().split(/\s+/)[0];
  const vendorKey = parsed.gpuVendor || inferGpuVendor(parsed.gpu || '');
  const vendorLabel = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[vendorKey] || '';
  const gpuModel = (parsed.gpu || '').trim();
  const parts = [osBase, vendorLabel, gpuModel].filter(Boolean);
  if (parts.length) return parts.join('-');
  return 'Uploaded system';
}

function summarizeSystem(parsed) {
  const bits = [parsed.os, parsed.cpu || parsed.gpu, parsed.ram].filter(Boolean);
  return bits.length ? bits.join(' • ') : 'No parsed hardware summary available yet.';
}

function getMyHwSourceMeta() {
  try {
    const raw = localStorage.getItem(MYHW_SOURCE_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setMyHwSourceMeta(meta) {
  if (!meta) {
    localStorage.removeItem(MYHW_SOURCE_META_KEY);
    return;
  }
  localStorage.setItem(MYHW_SOURCE_META_KEY, JSON.stringify(meta));
}

function getMyHwFieldOrigins() {
  try {
    const raw = localStorage.getItem(MYHW_FIELD_ORIGINS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setMyHwFieldOrigins(origins) {
  if (!origins || Object.keys(origins).length === 0) {
    localStorage.removeItem(MYHW_FIELD_ORIGINS_KEY);
    return;
  }
  localStorage.setItem(MYHW_FIELD_ORIGINS_KEY, JSON.stringify(origins));
}

function setMyHwFieldOrigin(field, origin) {
  const cur = getMyHwFieldOrigins();
  if (!origin) delete cur[field];
  else cur[field] = origin;
  setMyHwFieldOrigins(cur);
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
// Proton Pulse account ownership should come from the authenticated auth user
// id. Keep the legacy browser-local client_id as a compatibility fallback so
// older submissions still show up until the data is migrated.

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

async function fetchMyUserConfigs(protonPulseUserId, clientId, session) {
  // Public Pulse reports that show up on game pages.
  const filters = [];
  if (protonPulseUserId) {
    filters.push(`proton_pulse_user_id.eq.${encodeURIComponent(protonPulseUserId)}`);
  }
  if (clientId) {
    filters.push(`client_id.eq.${encodeURIComponent(clientId)}`);
  }
  if (!filters.length) return [];
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?or=(${filters.join(',')})`
    + `&select=id,app_id,title,proton_version,rating,created_at,updated_at,is_flagged,is_hidden,flagged_reason`
    + `&order=created_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

async function fetchMyCloudConfigs(protonPulseUserId, session) {
  if (!protonPulseUserId) return [];
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&select=app_id,app_name,updated_at,config,is_published`
    + `&order=updated_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Cloud lookup failed: HTTP ${r.status}`);
  return await r.json();
}

async function publishMyCloudConfig(protonPulseUserId, appId, session) {
  if (!protonPulseUserId || !appId) throw new Error('Missing report owner');
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify({ is_published: true }),
  });
  if (!r.ok) throw new Error(`Publish failed: HTTP ${r.status}`);
}

async function deleteMyReportsEverywhere(protonPulseUserId, clientId, appId, session) {
  const headers = { ...supabaseHeaders(session), Prefer: 'return=minimal' };
  const deletes = [];
  if (protonPulseUserId) {
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_proton_configs`
        + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_configs`
        + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
  }
  if (clientId) {
    deletes.push(fetch(
      `${SUPABASE_URL}/rest/v1/user_configs`
        + `?client_id=eq.${encodeURIComponent(clientId)}`
        + `&app_id=eq.${encodeURIComponent(appId)}`,
      { method: 'DELETE', headers },
    ));
  }

  const results = await Promise.all(deletes);
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(`Delete failed: HTTP ${failed.status}`);
}

async function fetchFullUserConfig(reportId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?id=eq.${encodeURIComponent(reportId)}`
    + `&select=id,app_id,title,rating,proton_version,os,notes,config_key,created_at,updated_at`
    + `&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Fetch report failed: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function fetchReportHistory(reportId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs_history`
    + `?config_id=eq.${encodeURIComponent(reportId)}`
    + `&select=id,rating,proton_version,os,notes,config_key,recorded_at`
    + `&order=recorded_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`History fetch failed: HTTP ${r.status}`);
  return await r.json();
}

async function patchUserConfig(reportId, fields, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_configs?id=eq.${encodeURIComponent(reportId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`Update failed: HTTP ${r.status}`);
}

async function fetchCloudConfig(protonPulseUserId, appId, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`
    + `&select=id,app_id,app_name,config,is_published`
    + `&limit=1`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Fetch config failed: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function patchCloudConfig(protonPulseUserId, appId, configPatch, session) {
  const url = `${SUPABASE_URL}/rest/v1/user_proton_configs`
    + `?proton_pulse_user_id=eq.${encodeURIComponent(protonPulseUserId)}`
    + `&app_id=eq.${encodeURIComponent(appId)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(session), Prefer: 'return=minimal' },
    body: JSON.stringify({ config: configPatch }),
  });
  if (!r.ok) throw new Error(`Config update failed: HTTP ${r.status}`);
}

let _cloudEditModal = null;
function getCloudEditModal() {
  if (_cloudEditModal) return _cloudEditModal;
  _cloudEditModal = document.createElement('dialog');
  _cloudEditModal.className = 'edit-report-modal';
  _cloudEditModal.innerHTML = `
    <h2 class="edit-report-title">Edit Cloud Config</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Proton Version
        <input class="edit-report-input" type="text" name="proton_version" placeholder="e.g. Proton 9.0">
      </label>
      <label class="edit-report-label">Launch Options
        <input class="edit-report-input" type="text" name="launch_options" placeholder="e.g. DXVK_HUD=1 %command%">
      </label>
      <label class="edit-report-label" title="One VAR=value per line">Environment Variables
        <textarea class="edit-report-input" name="enabled_vars" rows="4" placeholder="DXVK_FRAME_RATE=60&#10;PROTON_USE_WINED3D=1"></textarea>
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save Changes</button>
    </div>
  `;
  document.body.appendChild(_cloudEditModal);
  _cloudEditModal.querySelector('.edit-report-cancel').addEventListener('click', () => _cloudEditModal.close());
  return _cloudEditModal;
}

function enabledVarsToText(vars) {
  if (!vars || typeof vars !== 'object') return '';
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n');
}

function textToEnabledVars(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

async function showEditCloudConfigModal(protonPulseUserId, appId, session, onSaved) {
  const modal = getCloudEditModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  status.textContent = 'Loading config...';
  saveBtn.disabled = true;
  modal.showModal();

  let record;
  try {
    record = await fetchCloudConfig(protonPulseUserId, appId, session);
    console.debug('[profile] showEditCloudConfigModal: fetched', { appId, found: !!record });
  } catch (e) {
    status.textContent = e.message || 'Failed to load config';
    console.warn('[profile] showEditCloudConfigModal: fetch failed', { appId, error: String(e) });
    return;
  }
  if (!record) { status.textContent = 'Config not found.'; return; }

  status.textContent = '';
  saveBtn.disabled = false;
  const cfg = record.config || {};
  modal.querySelector('[name="proton_version"]').value = cfg.protonVersion || '';
  modal.querySelector('[name="launch_options"]').value = cfg.launchOptions || '';
  modal.querySelector('[name="enabled_vars"]').value = enabledVarsToText(cfg.enabledVars);

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';
    const newConfig = {
      ...cfg,
      protonVersion:  modal.querySelector('[name="proton_version"]').value.trim(),
      launchOptions:  modal.querySelector('[name="launch_options"]').value.trim(),
      enabledVars:    textToEnabledVars(modal.querySelector('[name="enabled_vars"]').value),
    };
    try {
      await patchCloudConfig(protonPulseUserId, appId, newConfig, session);
      console.debug('[profile] showEditCloudConfigModal: saved', { appId });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      console.warn('[profile] showEditCloudConfigModal: save failed', { appId, error: String(e) });
    } finally {
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = false;
    }
  };
}

let _editModal = null;
function getEditModal() {
  if (_editModal) return _editModal;
  _editModal = document.createElement('dialog');
  _editModal.className = 'edit-report-modal';
  _editModal.innerHTML = `
    <h2 class="edit-report-title">Edit Report</h2>
    <div class="edit-report-fields">
      <label class="edit-report-label">Rating
        <select class="edit-report-input" name="rating">
          <option value="platinum">Platinum</option>
          <option value="gold">Gold</option>
          <option value="silver">Silver</option>
          <option value="bronze">Bronze</option>
          <option value="borked">Borked</option>
        </select>
      </label>
      <label class="edit-report-label">Proton Version
        <input class="edit-report-input" type="text" name="proton_version" placeholder="e.g. Proton 9.0">
      </label>
      <label class="edit-report-label">OS
        <input class="edit-report-input" type="text" name="os" placeholder="e.g. SteamOS 3.6">
      </label>
      <label class="edit-report-label">Notes
        <textarea class="edit-report-input" name="notes" rows="4" placeholder="Optional notes about your experience"></textarea>
      </label>
      <label class="edit-report-label">Launch Options
        <input class="edit-report-input" type="text" name="config_key" placeholder="e.g. DXVK_HUD=1 %command%">
      </label>
    </div>
    <div class="edit-report-status"></div>
    <div class="edit-report-history-section">
      <button type="button" class="edit-report-history-toggle">Show edit history</button>
      <div class="edit-report-history-panel" hidden></div>
    </div>
    <div class="edit-report-actions">
      <button type="button" class="edit-report-cancel">Cancel</button>
      <button type="button" class="edit-report-save">Save Changes</button>
    </div>
  `;
  document.body.appendChild(_editModal);
  _editModal.querySelector('.edit-report-cancel').addEventListener('click', () => _editModal.close());
  return _editModal;
}

function renderHistoryPanel(entries) {
  if (!entries.length) return '<p class="edit-report-history-empty">No edit history yet.</p>';
  return entries.map(e => {
    const date = formatSystemUpdated(e.recorded_at);
    const parts = [
      e.rating       ? `<span class="hist-field">Rating: <b>${escapeHtml(e.rating)}</b></span>`               : '',
      e.proton_version ? `<span class="hist-field">Proton: <b>${escapeHtml(e.proton_version)}</b></span>`    : '',
      e.os           ? `<span class="hist-field">OS: <b>${escapeHtml(e.os)}</b></span>`                       : '',
      e.config_key   ? `<span class="hist-field">Launch opts: <b>${escapeHtml(e.config_key)}</b></span>`      : '',
      e.notes        ? `<span class="hist-field hist-notes">Notes: ${escapeHtml(e.notes)}</span>`             : '',
    ].filter(Boolean).join('');
    return `<div class="edit-report-history-entry"><span class="hist-date">${escapeHtml(date)}</span>${parts}</div>`;
  }).join('');
}

async function showEditReportModal(reportId, session, onSaved) {
  const modal = getEditModal();
  const status = modal.querySelector('.edit-report-status');
  const saveBtn = modal.querySelector('.edit-report-save');
  const histToggle = modal.querySelector('.edit-report-history-toggle');
  const histPanel = modal.querySelector('.edit-report-history-panel');
  status.textContent = 'Loading report...';
  saveBtn.disabled = true;
  histPanel.hidden = true;
  histPanel.innerHTML = '';
  histToggle.textContent = 'Show edit history';
  modal.showModal();

  let record;
  try {
    record = await fetchFullUserConfig(reportId, session);
    console.debug('[profile] showEditReportModal: fetched report', { reportId, found: !!record });
  } catch (e) {
    status.textContent = e.message || 'Failed to load report';
    console.warn('[profile] showEditReportModal: fetch failed', { reportId, error: String(e) });
    return;
  }
  if (!record) { status.textContent = 'Report not found.'; return; }

  status.textContent = '';
  saveBtn.disabled = false;
  modal.querySelector('[name="rating"]').value = record.rating || 'gold';
  modal.querySelector('[name="proton_version"]').value = record.proton_version || '';
  modal.querySelector('[name="os"]').value = record.os || '';
  modal.querySelector('[name="notes"]').value = record.notes || '';
  modal.querySelector('[name="config_key"]').value = record.config_key || '';

  let histLoaded = false;
  histToggle.onclick = async () => {
    const open = !histPanel.hidden;
    histPanel.hidden = open;
    histToggle.textContent = open ? 'Show edit history' : 'Hide edit history';
    if (!open && !histLoaded) {
      histPanel.textContent = 'Loading...';
      try {
        const entries = await fetchReportHistory(reportId, session);
        histPanel.innerHTML = renderHistoryPanel(entries);
        histLoaded = true;
        console.debug('[profile] showEditReportModal: history loaded', { reportId, count: entries.length });
      } catch (e) {
        histPanel.textContent = e.message || 'Failed to load history';
        console.warn('[profile] showEditReportModal: history fetch failed', { reportId, error: String(e) });
      }
    }
  };

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...';
    saveBtn.disabled = true;
    status.textContent = '';
    const fields = {
      rating:         modal.querySelector('[name="rating"]').value,
      proton_version: modal.querySelector('[name="proton_version"]').value.trim() || null,
      os:             modal.querySelector('[name="os"]').value.trim() || null,
      notes:          modal.querySelector('[name="notes"]').value.trim() || null,
      config_key:     modal.querySelector('[name="config_key"]').value.trim() || null,
    };
    try {
      await patchUserConfig(reportId, fields, session);
      console.debug('[profile] showEditReportModal: saved', { reportId, fields });
      modal.close();
      onSaved?.();
    } catch (e) {
      status.textContent = e.message || 'Save failed';
      console.warn('[profile] showEditReportModal: save failed', { reportId, error: String(e) });
    } finally {
      saveBtn.textContent = 'Save Changes';
      saveBtn.disabled = false;
    }
  };
}

function getMyReportBadges(row) {
  const badges = [];
  if (row.cloud) badges.push({ label: 'Cloud', tone: 'cloud' });
  if (row.published) badges.push({ label: 'Published', tone: 'published' });
  if (row.unpublished) badges.push({ label: 'Unpublished', tone: 'unpublished' });
  if (row.flagged) badges.push({ label: 'Flagged', tone: 'flagged' });
  return badges;
}

const FIELD_LABELS = {
  notes: 'your notes',
  title: 'the game title',
  launch_options: 'the launch options',
  'form_responses.onlineMultiplayerNotes': 'the online multiplayer notes',
  'form_responses.localMultiplayerNotes': 'the local multiplayer notes',
  'form_responses.framegenNotes': 'the frame generation notes',
  'form_responses.offlineNotes': 'the offline notes',
  'form_responses.generalNotes': 'the general notes',
};

function flaggedMessageHtml(flaggedReason) {
  if (!flaggedReason) return 'This report was flagged for review. Edit and resubmit to have it restored.';

  const discordLink = `<a href="https://discord.gg/3XskyBRswp" target="_blank" rel="noopener">Discord</a>`;

  if (flaggedReason.startsWith('wordlist:')) {
    const match = flaggedReason.match(/^wordlist:.+ in (.+)$/);
    const fieldKey = match?.[1] ?? '';
    const fieldLabel = FIELD_LABELS[fieldKey] || fieldKey.replace('form_responses.', '').replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return `A flagged word was detected in ${escapeHtml(fieldLabel)}. Edit your report to remove it and resubmit. If you think this is a mistake, reach out on ${discordLink}.`;
  }

  if (flaggedReason.startsWith('openai:')) {
    const categories = flaggedReason.replace('openai:', '').split(',').map(c =>
      c.replace(/-/g, ' ').replace(/\//g, ' / ')
    ).join(', ');
    return `Content was flagged for: ${escapeHtml(categories)}. Edit your report and resubmit. If you think this is a mistake, reach out on ${discordLink}.`;
  }

  return `This report was flagged for review. Edit and resubmit to have it restored. If you think this is a mistake, reach out on ${discordLink}.`;
}

function mergeMyReportRows(publishedRows, cloudRows) {
  const merged = new Map();

  function ensureRow(appId) {
    if (!merged.has(appId)) {
      merged.set(appId, {
        app_id: appId,
        title: '',
        rating: '',
        updated_at: '',
        published_at: '',
        published_id: null,
        created_at: '',
        cloud_updated_at: '',
        cloud_published: false,
        cloud: false,
        published: false,
        unpublished: false,
        flagged: false,
        flagged_reason: null,
      });
    }
    return merged.get(appId);
  }

  for (const row of publishedRows || []) {
    const mergedRow = ensureRow(row.app_id);
    mergedRow.title = row.title || mergedRow.title;
    mergedRow.rating = row.rating || mergedRow.rating;
    mergedRow.published = true;
    mergedRow.flagged = mergedRow.flagged || Boolean(row.is_flagged);
    mergedRow.flagged_reason = mergedRow.flagged_reason || row.flagged_reason || null;
    mergedRow.published_at = row.created_at || mergedRow.published_at;
    mergedRow.published_id = mergedRow.published_id || row.id || null;
    mergedRow.created_at = mergedRow.created_at || row.created_at || '';
    const rowTime = row.updated_at || row.created_at || '';
    if (rowTime && (!mergedRow.updated_at || new Date(rowTime).getTime() > new Date(mergedRow.updated_at || 0).getTime())) {
      mergedRow.updated_at = rowTime;
    }
  }

  for (const row of cloudRows || []) {
    const mergedRow = ensureRow(row.app_id);
    mergedRow.title = mergedRow.title || row.app_name || row.config?.appName || `App ${row.app_id}`;
    mergedRow.cloud = true;
    mergedRow.cloud_updated_at = row.updated_at || mergedRow.cloud_updated_at;
    mergedRow.cloud_published = Boolean(row.is_published) || mergedRow.cloud_published;
    if (!mergedRow.updated_at || new Date(row.updated_at || 0).getTime() > new Date(mergedRow.updated_at || 0).getTime()) {
      mergedRow.updated_at = row.updated_at || mergedRow.updated_at;
    }
  }

  for (const row of merged.values()) {
    row.published = row.published || row.cloud_published;
    row.unpublished = row.cloud && !row.cloud_published && !row.published;
  }

  return Array.from(merged.values()).sort((a, b) => {
    return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
  });
}

function pluginFunctionUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

async function callPluginLinkFunction(name, session, body) {
  const r = await fetch(pluginFunctionUrl(name), {
    method: 'POST',
    headers: supabaseHeaders(session),
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  const payload = text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : {};
  if (!r.ok) throw new Error(payload.error || payload.message || `HTTP ${r.status}`);
  return payload;
}

async function listLinkedPlugins(session) {
  return await callPluginLinkFunction('plugin-links-list', session, {});
}

async function completePluginLink(linkCode, session) {
  return await callPluginLinkFunction('plugin-link-complete', session, { linkCode });
}

async function removePluginLink(installationId, session) {
  return await callPluginLinkFunction('plugin-link-remove', session, { installationId });
}

function getPluginLinkCodeFromLocation(loc = window.location) {
  const searchCode = new URLSearchParams(loc.search || '').get('pluginLinkCode');
  if (searchCode) return searchCode;

  const hash = String(loc.hash || '');
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex === -1) return null;
  const hashQuery = hash.slice(hashQueryIndex + 1);
  return new URLSearchParams(hashQuery).get('pluginLinkCode');
}

// Mock data for localhost preview so the full profile page is testable offline
const MOCK_USER = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  email: 'deckpilot@protonmail.com',
  last_sign_in_at: new Date(Date.now() - 3600_000).toISOString(),
  user_metadata: {
    full_name: 'DeckPilot42',
    avatar_url: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
    steam_id: '76561198012345678',
  },
};
const MOCK_SYSTEMS = [
  {
    device_id: 'deck-lcd-001',
    label: 'Steam Deck LCD',
    is_default: true,
    updated_at: new Date(Date.now() - 86400_000 * 2).toISOString(),
    sysinfo_text: 'CPU Brand: AMD Custom APU 0405\nVideo Card: AMD Custom GPU 0405 (VanGogh)\nRAM: 16384 Mb\nOS Version: SteamOS 3.5.17 (Jupiter)\nDriver Version: Mesa 24.1.0\nKernel Version: 6.5.0-valve22',
  },
  {
    device_id: 'desktop-001',
    label: 'Desktop',
    is_default: false,
    updated_at: new Date(Date.now() - 86400_000 * 10).toISOString(),
    sysinfo_text: 'CPU Brand: AMD Ryzen 7 5800X3D 8-Core Processor\nVideo Card: NVIDIA GeForce RTX 4070\nRAM: 32768 Mb\nOS Version: Arch Linux\nDriver Version: 555.42.02\nKernel Version: 6.8.12-arch1-1',
  },
];
const MOCK_LINKED_PLUGINS = [
  { installation_id: 'inst-deck-lcd-001', device_label: 'Steam Deck LCD', linked_at: new Date(Date.now() - 86400_000 * 30).toISOString() },
];
const MOCK_REPORTS = [
  { app_id: 1091500, title: 'Cyberpunk 2077', rating: 'Gold', updated_at: new Date(Date.now() - 86400_000 * 3).toISOString(), cloud: true, unpublished: false },
  { app_id: 1245620, title: 'Elden Ring',     rating: 'Gold', updated_at: new Date(Date.now() - 86400_000 * 7).toISOString(), cloud: true, unpublished: false },
  { app_id: 292030,  title: 'The Witcher 3: Wild Hunt', rating: 'Platinum', updated_at: new Date(Date.now() - 86400_000 * 14).toISOString(), cloud: false, unpublished: false },
  { app_id: 413150,  title: 'Stardew Valley', rating: 'Platinum', updated_at: new Date(Date.now() - 86400_000 * 21).toISOString(), cloud: true, unpublished: true },
];

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
  const configTypeSelect = document.getElementById('config-type');
  const pluginLinkCodeInput = document.getElementById('plugin-link-code');
  const pluginLinkSubmitBtn = document.getElementById('plugin-link-submit-btn');
  const pluginLinkStatus = document.getElementById('plugin-link-status');
  const pluginLinkEntry = document.getElementById('plugin-link-entry');
  const pluginLinkEntryBody = document.getElementById('plugin-link-entry-body');
  const pluginLinkJumpBtn = document.getElementById('plugin-link-jump-btn');
  const pluginLinkCopyBtn = document.getElementById('plugin-link-copy-btn');
  const linkedPluginsSection = document.getElementById('linked-plugins-section');
  const linkedPluginsLoading = document.getElementById('linked-plugins-loading');
  const linkedPluginsEmpty = document.getElementById('linked-plugins-empty');
  const linkedPluginsList = document.getElementById('linked-plugins-list');

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
  const myhwSourceTitle = document.getElementById('myhw-source-title');
  const myhwSourceBody  = document.getElementById('myhw-source-body');
  const myhwTabButtons = Array.from(document.querySelectorAll('.profile-tab-btn[data-pane]'));
  const myhwTabPanels  = {
    systems: document.getElementById('myhw-pane-systems'),
    local: document.getElementById('myhw-pane-local'),
  };
  let suppressMyHwSourceTracking = false;

  function setMyHardwarePane(name) {
    myhwTabButtons.forEach((btn) => {
      const active = btn.dataset.pane === name;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    for (const [pane, el] of Object.entries(myhwTabPanels)) {
      if (!el) continue;
      const active = pane === name;
      el.classList.toggle('active', active);
      el.hidden = !active;
    }
  }

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

  function renderMyHwSource() {
    if (!myhwSourceTitle || !myhwSourceBody) return;
    const meta = getMyHwSourceMeta();
    const anyLocal = Object.values(MYHW_KEYS).some((k) => localStorage.getItem(k));
    if (!meta) {
      myhwSourceTitle.textContent = anyLocal ? 'Manual browser values' : 'No source selected yet';
      myhwSourceBody.textContent = anyLocal
        ? 'These values were entered directly in this browser and will pre-fill the web submit form.'
        : 'Save values here manually, paste Steam System Information, or set a default uploaded system above.';
      return;
    }
    if (meta.type === 'uploaded-default') {
      myhwSourceTitle.textContent = `Default uploaded system: ${meta.label || 'Uploaded system'}`;
      myhwSourceBody.textContent = 'The Web prefill values below were copied from your default uploaded system and are used to pre-fill the submit-a-report form until you edit them.';
      return;
    }
    if (meta.type === 'customized') {
      myhwSourceTitle.textContent = `Customized browser copy${meta.originLabel ? ` of ${meta.originLabel}` : ''}`;
      myhwSourceBody.textContent = 'These values started from another source, then were edited in this browser. The edited values below now control web form prefill.';
      return;
    }
    if (meta.type === 'steam-paste') {
      myhwSourceTitle.textContent = 'Pasted Steam System Information';
      myhwSourceBody.textContent = 'These values were parsed from the Steam System Information text you pasted here and now pre-fill the web submit form.';
      return;
    }
    myhwSourceTitle.textContent = 'Manual browser values';
    myhwSourceBody.textContent = 'These values were entered directly in this browser and will pre-fill the web submit form.';
  }

  // Map the meta.type we use in source-meta over to the short key used for
  // per-field origin badges. steam-paste and uploaded-default both write all
  // fields at once, so every field written inherits that type.
  function fieldOriginKeyFor(sourceMeta) {
    if (!sourceMeta) return null;
    if (sourceMeta.type === 'uploaded-default') return 'default-system';
    if (sourceMeta.type === 'steam-paste')      return 'steam-paste';
    return null;
  }

  function renderMyHwFieldOrigins() {
    const origins = getMyHwFieldOrigins();
    document.querySelectorAll('[data-myhw-origin]').forEach((el) => {
      const field  = el.dataset.myhwOrigin;
      const origin = origins[field];
      const caption = origin ? MYHW_ORIGIN_LABELS[origin] : '';
      el.textContent = caption || '';
      if (caption) el.setAttribute('data-origin', origin);
      else el.removeAttribute('data-origin');
    });
  }

  function setLocalHardwareFromParsed(parsed, sourceMeta) {
    suppressMyHwSourceTracking = true;
    try {
      const originKey = fieldOriginKeyFor(sourceMeta);
      // Reset ALL origins before writing, so fields that aren't in this parsed
      // batch don't keep a stale "from default system" label
      const nextOrigins = {};
      for (const [field, val] of Object.entries(parsed)) {
        const el = myhwInputs[field];
        if (!el) continue;
        el.value = val;
        saveMyHwField(field, val);
        if (originKey) nextOrigins[field] = originKey;
      }
      setMyHwFieldOrigins(nextOrigins);
      setMyHwSourceMeta(sourceMeta);
      renderMyHwSource();
      renderMyHwFieldOrigins();
    } finally {
      suppressMyHwSourceTracking = false;
    }
  }

  function markLocalHardwareEdited(field) {
    if (suppressMyHwSourceTracking) return;
    if (field) setMyHwFieldOrigin(field, 'manual');
    const prev = getMyHwSourceMeta();
    if (!prev) {
      setMyHwSourceMeta({ type: 'manual' });
    } else if (prev.type === 'uploaded-default' || prev.type === 'steam-paste') {
      setMyHwSourceMeta({
        type: 'customized',
        originType: prev.type,
        originLabel: prev.label || '',
      });
    }
    renderMyHwSource();
    renderMyHwFieldOrigins();
  }

  function showUser(user, session) {
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
      // Use Supabase user_metadata as authoritative source; fall back to localStorage
      // for users who set the preference before this sync was added.
      const meta = user.user_metadata ?? {};
      const fromMeta = typeof meta.show_username === 'boolean' ? meta.show_username : null;
      const val = fromMeta !== null ? fromMeta : getShowUsername();
      if (fromMeta !== null) setShowUsername(val); // keep localStorage in sync
      usernameToggle.checked = val;
      usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
    }
    if (hwGpuSelect) hwGpuSelect.value = localStorage.getItem(HW_GPU_KEY) || '';
    if (hwOsInput)   hwOsInput.value   = localStorage.getItem(HW_OS_KEY)  || '';
    if (configTypeSelect) configTypeSelect.value = localStorage.getItem(CONFIG_TYPE_KEY) || '';
    loadMyHardware();
    renderMyHwSource();
    renderMyHwFieldOrigins();

    signedOut.hidden = true;
    signedIn.hidden  = false;

    // Show Role field if user is an admin.
    checkIsAdminProfile(session).then(function (admin) {
      const roleField = document.getElementById('profile-role-field');
      if (roleField) roleField.hidden = !admin;
    });
  }

  async function checkIsAdminProfile(session) {
    if (!session || !session.access_token) return false;
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/admins?select=proton_pulse_user_id&limit=1',
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token } }
      );
      if (!res.ok) return false;
      const rows = await res.json();
      return Array.isArray(rows) && rows.length > 0;
    } catch (_) { return false; }
  }

  function showSignedOut() {
    signedIn.hidden  = true;
    signedOut.hidden = false;
  }

  function showPluginLinkStatus(msg, ok) {
    if (!pluginLinkStatus) return;
    pluginLinkStatus.textContent = msg;
    pluginLinkStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => {
      if (pluginLinkStatus.textContent === msg) pluginLinkStatus.textContent = '';
    }, 3000);
  }

  function focusPluginLinkArea() {
    linkedPluginsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pluginLinkCodeInput?.focus?.();
    pluginLinkCodeInput?.select?.();
  }

  function renderLinkedPlugins(rows) {
    if (!linkedPluginsLoading || !linkedPluginsEmpty || !linkedPluginsList) return;
    linkedPluginsLoading.hidden = true;
    if (!rows || rows.length === 0) {
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsList.innerHTML = '';
      return;
    }
    linkedPluginsEmpty.hidden = true;
    linkedPluginsList.hidden = false;
    linkedPluginsList.innerHTML = rows.map((row) => {
      const installationId = escapeHtml(String(row.installationId || ''));
      const linkedAt = escapeHtml(formatSystemUpdated(row.linkedAt));
      const lastSeenAt = escapeHtml(formatSystemUpdated(row.lastSeenAt));
      return `
        <div class="profile-prefill-source" style="margin-bottom:10px">
          <div class="profile-prefill-source-title">${installationId}</div>
          <div class="profile-prefill-source-body">
            Linked: ${linkedAt}<br>
            Last seen: ${lastSeenAt}
          </div>
          <div style="margin-top:8px">
            <button type="button" class="profile-clear-btn linked-plugin-remove-btn" data-installation-id="${installationId}">Unlink</button>
          </div>
        </div>`;
    }).join('');
    linkedPluginsList.querySelectorAll('.linked-plugin-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const installationId = btn.getAttribute('data-installation-id');
        if (!installationId) return;
        try {
          const s = await SupaAuth.getSession();
          if (!s?.user) throw new Error('Sign in with Steam first.');
          await removePluginLink(installationId, s);
          showPluginLinkStatus('Plugin unlinked.', true);
          await refreshLinkedPlugins();
        } catch (e) {
          showPluginLinkStatus(e.message || 'Failed to unlink plugin.', false);
        }
      });
    });
  }

  async function refreshLinkedPlugins() {
    if (!linkedPluginsLoading || !linkedPluginsEmpty || !linkedPluginsList) return;
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      linkedPluginsLoading.hidden = true;
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsEmpty.textContent = 'Sign in with Steam to manage linked plugins.';
      return;
    }
    linkedPluginsLoading.hidden = false;
    linkedPluginsEmpty.hidden = true;
    try {
      const rows = await listLinkedPlugins(s);
      renderLinkedPlugins(rows);
    } catch (e) {
      linkedPluginsLoading.hidden = true;
      linkedPluginsList.hidden = true;
      linkedPluginsEmpty.hidden = false;
      linkedPluginsEmpty.textContent = e.message || 'Failed to load linked plugins.';
    }
  }

  // ── Initial state ──────────────────────────────────────────────────────────
  if (IS_LOCAL_DEV) {
    // skip Supabase on localhost, show mock profile
    showUser(MOCK_USER);
  } else {
    const session = await SupaAuth.getSession();
    if (session?.user) {
      showUser(session.user);
      void refreshLinkedPlugins();
    } else {
      showSignedOut();
    }

    // ── Stay in sync (e.g. sign-out in another tab) ─────────────────────────
    SupaAuth.onStateChange(({ user, session }) => {
      if (user) {
        showUser(user, session);
        void refreshLinkedPlugins();
      } else {
        showSignedOut();
      }
    });
  }

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
    const val = usernameToggle.checked;
    setShowUsername(val);
    if (usernameStatus) usernameStatus.textContent = val ? 'Shown on reports' : 'Anonymous';
    // persist to Supabase so the preference follows the account across devices
    SupaAuth.updateUserMeta({ show_username: val }).catch((e) => {
      console.warn('[profile] failed to persist show_username to Supabase user_metadata:', e);
    });
  });

  hwGpuSelect?.addEventListener('change', () => {
    localStorage.setItem(HW_GPU_KEY, hwGpuSelect.value);
  });

  hwOsInput?.addEventListener('change', () => {
    localStorage.setItem(HW_OS_KEY, hwOsInput.value.trim());
  });

  configTypeSelect?.addEventListener('change', () => {
    const value = configTypeSelect.value || '';
    if (value) localStorage.setItem(CONFIG_TYPE_KEY, value);
    else localStorage.removeItem(CONFIG_TYPE_KEY);
  });

  pluginLinkSubmitBtn?.addEventListener('click', async () => {
    const linkCode = (pluginLinkCodeInput?.value || '').trim().toUpperCase();
    if (!linkCode) {
      showPluginLinkStatus('Enter a link code first.', false);
      return;
    }
    try {
      const s = await SupaAuth.getSession();
      if (!s?.user) throw new Error('Sign in with Steam first.');
      await completePluginLink(linkCode, s);
      if (pluginLinkCodeInput) pluginLinkCodeInput.value = '';
      showPluginLinkStatus('Plugin linked to your Proton Pulse account.', true);
      await refreshLinkedPlugins();
    } catch (e) {
      showPluginLinkStatus(e.message || 'Failed to link plugin.', false);
    }
  });

  const linkCodeFromUrl = getPluginLinkCodeFromLocation();
  if (linkCodeFromUrl && pluginLinkCodeInput && !pluginLinkCodeInput.value) {
    pluginLinkCodeInput.value = linkCodeFromUrl.toUpperCase();
    if (pluginLinkEntry) pluginLinkEntry.hidden = false;
    if (pluginLinkEntryBody) {
      pluginLinkEntryBody.innerHTML = `We prefilled the Decky link code <strong>${escapeHtml(linkCodeFromUrl.toUpperCase())}</strong>. Review it below, then press <strong>Link plugin</strong>.`;
    }
    if (session?.user) {
      setTimeout(() => { focusPluginLinkArea(); }, 50);
      showPluginLinkStatus('Decky link code loaded. Press "Link plugin" to finish linking.', true);
    }
  }

  pluginLinkJumpBtn?.addEventListener('click', () => {
    focusPluginLinkArea();
  });

  pluginLinkCopyBtn?.addEventListener('click', async () => {
    const code = (pluginLinkCodeInput?.value || '').trim().toUpperCase();
    if (!code) {
      showPluginLinkStatus('No Decky link code is loaded yet.', false);
      return;
    }
    try {
      await navigator.clipboard?.writeText(code);
      showPluginLinkStatus('Link code copied.', true);
    } catch {
      showPluginLinkStatus('Could not copy the link code.', false);
    }
  });

  // Save each My-hardware field as it changes, and flag it as manually edited
  // so the per-field origin badge flips to "edited"
  for (const [field, el] of Object.entries(myhwInputs)) {
    el?.addEventListener('change', () => {
      saveMyHwField(field, el.value);
      markLocalHardwareEdited(field);
    });
  }
  myhwTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => setMyHardwarePane(btn.dataset.pane));
  });
  setMyHardwarePane('systems');

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
      filled++;
    }

    if (filled > 0) {
      setLocalHardwareFromParsed(parsed, { type: 'steam-paste' });
    }

    if (filled === 0) flashStatus('Nothing recognized, check the format', false);
    else              flashStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}`, true);
  });

  // Wipe everything in My hardware including the paste area
  myhwClearBtn?.addEventListener('click', () => {
    suppressMyHwSourceTracking = true;
    for (const [field, el] of Object.entries(myhwInputs)) {
      if (!el) continue;
      el.value = '';
      localStorage.removeItem(MYHW_KEYS[field]);
    }
    if (myhwPasteArea) myhwPasteArea.value = '';
    setMyHwSourceMeta(null);
    renderMyHwSource();
    suppressMyHwSourceTracking = false;
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
    systemsTbody.innerHTML = rows.map(r => {
      const parsed = parseUploadedSystem(r);
      const displayLabel = isGenericSystemLabel(r.label) ? inferSystemLabel(r) : (r.label || 'Uploaded system');
      const summary = summarizeSystem(parsed);
      const detailRows = [
        ['CPU', parsed.cpu],
        ['GPU', parsed.gpu],
        ['GPU vendor', parsed.gpuVendor ? ({ nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[parsed.gpuVendor] || parsed.gpuVendor) : ''],
        ['GPU driver', parsed.gpuDriver],
        ['RAM', parsed.ram],
        ['VRAM', parsed.vramMb ? `${parsed.vramMb} MB` : ''],
        ['OS', [parsed.os, parsed.osVersion].filter(Boolean).join(' ')],
        ['Kernel', parsed.kernel],
      ].filter(([, value]) => value);
      return `
      <tr data-device-id="${escapeHtml(r.device_id)}">
        <td>
          <div class="profile-systems-label-stack">
            <input type="text" class="profile-systems-label-input"
              data-role="label" value="${escapeHtml(displayLabel)}" maxlength="80">
            <div class="profile-systems-summary">${escapeHtml(summary)}</div>
            <button type="button" class="profile-systems-view-btn" data-role="toggle-details" aria-expanded="false">View hardware</button>
          </div>
        </td>
        <td>${escapeHtml(formatSystemUpdated(r.updated_at))}</td>
        <td class="col-default">
          <label class="profile-systems-default-toggle" title="Set as default">
            <input type="checkbox" data-role="default" ${r.is_default ? 'checked' : ''}>
            <span class="profile-systems-default-switch" aria-hidden="true"></span>
            <span class="profile-systems-default-text">Default</span>
          </label>
        </td>
        <td class="col-delete">
          <button type="button" class="profile-systems-trash" data-role="delete" title="Delete">x</button>
        </td>
      </tr>
      <tr class="profile-systems-details-row" data-details-for="${escapeHtml(r.device_id)}" hidden>
        <td colspan="4">
          <div class="profile-systems-details-card">
            <div class="profile-systems-details-grid">
              ${detailRows.map(([label, value]) => `
                <div class="profile-systems-detail-item">
                  <span class="profile-systems-detail-label">${escapeHtml(label)}</span>
                  <span class="profile-systems-detail-value">${escapeHtml(value)}</span>
                </div>`).join('')}
            </div>
            <div class="profile-systems-detail-note">
              ${r.is_default
                ? 'This default uploaded system currently seeds the Web prefill tab and submit form until you edit those values locally.'
                : 'Mark this as default to use it as the starting source for the Web prefill tab and submit form.'}
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function showSystemsStatus(msg, ok) {
    if (!systemsStatus) return;
    systemsStatus.textContent = msg;
    systemsStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { systemsStatus.textContent = ''; }, 2500);
  }

  async function refreshSystems() {
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) {
      systemsLoading.hidden = true;
      systemsTable.hidden = true;
      systemsEmpty.hidden = false;
      systemsEmpty.textContent = 'Sign in with Steam to see your uploaded systems.';
      return;
    }
    systemsLoading.hidden = false;
    try {
      let rows = await listUserSystems(protonPulseUserId, s);
      const genericRows = rows.filter((row) => isGenericSystemLabel(row.label));
      if (genericRows.length) {
        await Promise.allSettled(genericRows.map((row) => {
          const nextLabel = inferSystemLabel(row);
          return updateSystemLabel(protonPulseUserId, row.device_id, nextLabel, s);
        }));
        rows = rows.map((row) => isGenericSystemLabel(row.label)
          ? { ...row, label: inferSystemLabel(row) }
          : row);
      }
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
    const label = isGenericSystemLabel(row.label) ? inferSystemLabel(row) : (row.label || 'this system');
    const ok = window.confirm(`Replace your local pre-fill values with "${label}"?`);
    if (!ok) return;
    if (parsed.gpu && !parsed.gpuVendor) {
      const v = inferGpuVendor(parsed.gpu);
      if (v) parsed.gpuVendor = v;
    }
    setLocalHardwareFromParsed(parsed, {
      type: 'uploaded-default',
      label,
      deviceId: row.device_id,
    });
    flashStatus('Local values updated from default system', true);
  }

  async function handleSystemsClick(ev) {
    const tr  = ev.target.closest('tr[data-device-id]');
    const btn = ev.target.closest('button[data-role]');
    const defToggle = ev.target.closest('input[data-role="default"]');
    if (!tr || (!btn && !defToggle)) return;
    const deviceId = tr.dataset.deviceId;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;

    try {
      if (defToggle) {
        // defToggle.checked is the state AFTER the click. true = user is
        // turning the default ON for this system; false = they flipped OFF
        // the only checked toggle and want no default at all
        if (defToggle.checked) {
          await setDefaultSystem(protonPulseUserId, deviceId, s);
          await refreshSystems();
          const row = systemsCache.find(r => r.device_id === deviceId);
          if (row) askReplaceLocalFrom(row);
          setMyHardwarePane('local');
        } else {
          await clearDefaultSystem(protonPulseUserId, s);
          await refreshSystems();
          flashStatus('Default cleared', true);
        }
        return;
      }
      if (btn.dataset.role === 'toggle-details') {
        const detailRow = Array.from(systemsTbody?.querySelectorAll('tr[data-details-for]') || [])
          .find((row) => row.getAttribute('data-details-for') === deviceId);
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        btn.textContent = expanded ? 'View hardware' : 'Hide hardware';
        if (detailRow) detailRow.hidden = expanded;
        return;
      }
      if (btn.dataset.role === 'delete') {
        if (!window.confirm('Delete this system? The plugin will re-create it next time you upload.')) return;
        await deleteSystem(protonPulseUserId, deviceId, s);
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
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const currentRow = systemsCache.find((row) => row.device_id === deviceId);
      const nextLabel = input.value.trim() || inferSystemLabel(currentRow || {});
      input.value = nextLabel;
      await updateSystemLabel(protonPulseUserId, deviceId, nextLabel, s);
      showSystemsStatus('Saved', true);
    } catch (e) {
      showSystemsStatus(e.message || 'Save failed', false);
    }
  }

  systemsTable?.addEventListener('click', handleSystemsClick);
  systemsTable?.addEventListener('focusout', handleSystemsLabelBlur);
  systemsRefresh?.addEventListener('click', () => { void refreshSystems(); });

  // manual system add form
  const addSysBtn = document.getElementById('add-system-btn');
  const addSysForm = document.getElementById('add-system-form');
  const addSysSubmit = document.getElementById('add-sys-submit');
  const addSysCancel = document.getElementById('add-sys-cancel');
  const addSysStatus = document.getElementById('add-sys-status');
  if (addSysBtn && addSysForm) {
    addSysBtn.addEventListener('click', () => {
      addSysForm.hidden = !addSysForm.hidden;
      addSysBtn.textContent = addSysForm.hidden ? '+ Add system' : '- Cancel';
    });
  }

  if (addSysCancel && addSysForm && addSysBtn) {
    addSysCancel.addEventListener('click', () => {
      addSysForm.hidden = true;
      addSysBtn.textContent = '+ Add system';
    });
  }

  addSysSubmit?.addEventListener('click', async () => {
    const label = document.getElementById('add-sys-label')?.value?.trim() || 'Manual system';
    const cpu = document.getElementById('add-sys-cpu')?.value?.trim() || '';
    const gpu = document.getElementById('add-sys-gpu')?.value?.trim() || '';
    const gpuVendor = document.getElementById('add-sys-gpu-vendor')?.value || '';
    const gpuDriver = document.getElementById('add-sys-gpu-driver')?.value?.trim() || '';
    const ram = document.getElementById('add-sys-ram')?.value?.trim() || '';
    const vram = document.getElementById('add-sys-vram')?.value?.trim() || '';
    const os = document.getElementById('add-sys-os')?.value?.trim() || '';
    const kernel = document.getElementById('add-sys-kernel')?.value?.trim() || '';

    if (!cpu && !gpu) {
      if (addSysStatus) { addSysStatus.textContent = 'At least CPU or GPU is needed'; addSysStatus.style.color = 'var(--red)'; }
      return;
    }

    // build a sysinfo_text blob that parseSteamSystemInfo can read back
    const lines = [];
    if (cpu) lines.push(`CPU Brand: ${cpu}`);
    if (gpu) lines.push(`Video Card: ${gpu}`);
    if (gpuDriver) lines.push(`Driver Version: ${gpuDriver}`);
    // convert user-entered GB to the MB format parseSteamSystemInfo expects
    if (ram) {
      const gb = parseInt(ram.replace(/[^0-9]/g, ''), 10);
      lines.push(`RAM: ${gb * 1024} Mb`);
    }
    if (vram) lines.push(`VRAM: ${vram} Mb`);
    if (os) lines.push(`OS Version: ${os}`);
    if (kernel) lines.push(`Kernel Version: ${kernel}`);
    const sysinfoText = lines.join('\n');

    // generate a device_id for web-created systems so they dont collide
    const deviceId = 'web-' + crypto.randomUUID().slice(0, 12);

    try {
      addSysSubmit.disabled = true;
      addSysSubmit.textContent = 'Saving...';
      const s = await SupaAuth.getSession();
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      if (!protonPulseUserId) throw new Error('Not signed in');

      const isFirst = systemsCache.length === 0;

      const resp = await fetch(supabaseUserSystemsUrl(), {
        method: 'POST',
        headers: supabaseHeaders(s, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          proton_pulse_user_id: protonPulseUserId,
          device_id: deviceId,
          label,
          sysinfo_text: sysinfoText,
          is_default: isFirst,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) throw new Error(`Save failed: HTTP ${resp.status}`);

      addSysForm.hidden = true;
      addSysBtn.textContent = '+ Add system';
      // clear the form inputs
      ['add-sys-label','add-sys-cpu','add-sys-gpu','add-sys-gpu-vendor','add-sys-gpu-driver','add-sys-ram','add-sys-vram','add-sys-os','add-sys-kernel']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      showSystemsStatus('System added', true);
      void refreshSystems();
    } catch (e) {
      if (addSysStatus) { addSysStatus.textContent = e.message || 'Failed'; addSysStatus.style.color = 'var(--red)'; }
    } finally {
      addSysSubmit.disabled = false;
      addSysSubmit.textContent = 'Save system';
    }
  });

  // Initial fetch so the table populates on page load
  void refreshSystems();

  // First-load convenience: if the user has nothing in Block 2 locally and
  // they've got a default system uploaded, copy its parsed sysinfo into the
  // inputs. Never clobbers existing local values
  async function autoFillFromDefaultIfEmpty() {
    const anyLocal = Object.values(MYHW_KEYS).some(k => localStorage.getItem(k));
    if (anyLocal) return;
    const s = await SupaAuth.getSession();
    const protonPulseUserId = getProtonPulseUserIdFromSession(s);
    if (!protonPulseUserId) return;
    try {
      const rows = await listUserSystems(protonPulseUserId, s);
      const def = rows.find(r => r.is_default);
      if (!def) return;
      const parsed = parseUploadedSystem(def);
      const label = isGenericSystemLabel(def.label) ? inferSystemLabel(def) : (def.label || 'your system');
      setLocalHardwareFromParsed(parsed, {
        type: 'uploaded-default',
        label,
        deviceId: def.device_id,
      });
      if (Object.keys(parsed).length > 0) {
        flashStatus(`Loaded hardware from "${label}"`, true);
      }
    } catch {
      // non-fatal, just leave Block 2 empty
    }
  }

  void autoFillFromDefaultIfEmpty();

  // ── My reports ────────────────────────────────────────────────────────────
  // Merge publicly published Pulse reports with cloud-synced plugin configs so
  // the profile can show both "published" and "still only in cloud" states.
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
      const reportAnchor = row.published_id ? `${appLink}#report-r${row.published_id}` : null;
      const viewHref = reportAnchor || appLink;
      const name = row.title || `App ${row.app_id}`;
      const badges = getMyReportBadges(row).map((badge) => (
        `<span class="profile-configs-badge profile-configs-badge--${escapeHtml(badge.tone)}">${escapeHtml(badge.label)}</span>`
      )).join('');
      const flaggedNote = row.flagged
        ? `<details class="profile-configs-flagged-details">
            <summary>Why was this flagged?</summary>
            <p>${flaggedMessageHtml(row.flagged_reason)}</p>
          </details>`
        : '';
      const actions = [
        viewHref
          ? `<a class="profile-configs-view-link" href="${escapeHtml(viewHref)}">View</a>`
          : `<span class="profile-configs-view-link profile-configs-view-disabled" title="Not published">View</span>`,
        // Publish on an unpublished cloud row -> open submit.html in
        // "complete from cloud" mode. A config without form responses is
        // effectively an incomplete draft; the user must answer the
        // can-install/start/play/verdict + fault questions before it can
        // be published as a real report. submit.html prefills what we
        // already have (proton version, launch options, hardware) and
        // validation enforces the rest before save
        row.cloud && row.unpublished
          ? `<a class="profile-configs-action profile-configs-publish-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1" target="_blank" rel="noopener">Publish</a>`
          : '',
        // Edit: published rows go to submit.html in edit mode (full form
        // pre-fill from user_configs). Cloud-only rows ALSO go to
        // submit.html in "complete from cloud" mode -- there's no real
        // difference between editing a draft and publishing it, both
        // require filling out the report responses
        row.published_id
          ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&edit=${escapeHtml(String(row.published_id))}" target="_blank" rel="noopener">Edit</a>`
          : row.cloud
            ? `<a class="profile-configs-action profile-configs-edit-btn" href="submit.html?app=${escapeHtml(String(row.app_id))}&fromCloud=1" target="_blank" rel="noopener">Edit</a>`
            : '',
        `<button type="button" class="profile-configs-action profile-configs-delete-btn" data-app-id="${escapeHtml(String(row.app_id))}">Delete</button>`,
      ].filter(Boolean).join('');
      return `
        <tr data-app-id="${escapeHtml(String(row.app_id))}">
          <td>
            <a href="${escapeHtml(appLink)}" class="profile-configs-game-link">${escapeHtml(name)}</a>
            <div class="profile-configs-appid">App ${escapeHtml(String(row.app_id))}</div>
          </td>
          <td>${escapeHtml(row.rating || '—')}</td>
          <td><div class="profile-configs-status">${badges}</div>${flaggedNote}</td>
          <td>${escapeHtml(formatSystemUpdated(row.updated_at))}</td>
          <td class="col-action"><div class="profile-configs-actions">${actions}</div></td>
        </tr>`;
    }).join('');
  }

  async function refreshMyConfigs() {
    const s = await SupaAuth.getSession();
    if (!s?.user) {
      myConfigsLoading.hidden = true;
      myConfigsTable.hidden   = true;
      myConfigsEmpty.hidden   = false;
      myConfigsEmpty.textContent = 'Sign in with Steam to see your reports and cloud-synced configs.';
      return;
    }
    myConfigsLoading.hidden = false;
    myConfigsEmpty.hidden   = true;
    try {
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid  = getWebClientIdProfile();
      const [publishedRows, cloudRows] = await Promise.all([
        fetchMyUserConfigs(protonPulseUserId, cid, s),
        fetchMyCloudConfigs(protonPulseUserId, s),
      ]);
      renderMyConfigs(mergeMyReportRows(publishedRows, cloudRows));
    } catch (e) {
      myConfigsLoading.hidden = true;
      showMyConfigsStatus(e.message || 'Failed to load', false);
    }
  }

  myConfigsRefresh?.addEventListener('click', () => { void refreshMyConfigs(); });
  myConfigsTbody?.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.closest('.profile-configs-publish-btn, .profile-configs-delete-btn, .profile-configs-edit-btn');
    if (!(action instanceof HTMLElement)) return;

    void (async () => {
      const s = await SupaAuth.getSession();
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid = getWebClientIdProfile();

      if (action.classList.contains('profile-configs-edit-btn')) {
        const reportId    = action.dataset.reportId;
        const cloudAppId  = action.dataset.cloudAppId;
        if (reportId) {
          void showEditReportModal(reportId, s, async () => {
            showMyConfigsStatus('Report updated', true);
            await refreshMyConfigs();
          });
        } else if (cloudAppId) {
          void showEditCloudConfigModal(protonPulseUserId, cloudAppId, s, async () => {
            showMyConfigsStatus('Config updated', true);
            await refreshMyConfigs();
          });
        }
        return;
      }

      const appId = action.dataset.appId;
      if (!appId) return;

      // Publish + Edit are now <a> links that navigate to submit.html,
      // so the only inline action left is Delete. The browser handles
      // the anchor click without firing this handler for them (no
      // data-app-id on the new anchors either since we matched the
      // selector above already, but the dataset.appId guard above
      // covers it -- only delete-btn carries data-app-id in this
      // updated markup)
      if (!action.classList.contains('profile-configs-delete-btn')) return;
      if (!window.confirm('Delete this report/config from Proton Pulse?')) return;
      action.textContent = 'Deleting...';
      await deleteMyReportsEverywhere(protonPulseUserId, cid, appId, s);
      showMyConfigsStatus('Deleted', true);
      await refreshMyConfigs();
    })().catch((err) => {
      showMyConfigsStatus(err?.message || 'Action failed', false);
      void refreshMyConfigs();
    });
  });

  void refreshMyConfigs();

  // Topbar auth chip + mobile nav are now wired in topbar.js (shared across all pages)
})();
