// profile.js — My Account page logic

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

// Turn OFF the default flag across every row for this user. We don't target a
// single device here because "no default" is the desired end state and going
// row-by-row would risk a brief window where two rows are default at once
async function clearDefaultSystem(steamId, session) {
  const base = supabaseUserSystemsUrl(`steam_id=eq.${encodeURIComponent(steamId)}`);
  const r = await fetch(base, {
    method: 'PATCH',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_default: false }),
  });
  if (!r.ok) throw new Error(`Clear default failed: HTTP ${r.status}`);
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

function getProtonPulseUserIdFromSession(session) {
  return session?.user?.id || null;
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
  // Your submitted reports, the ones that show up on public game pages
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
    + `&select=id,app_id,title,proton_version,rating,created_at`
    + `&order=created_at.desc`;
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

// -- Linked plugin devices helpers --
function supabaseClaimedIdsUrl(query) {
  return `${SUPABASE_URL}/rest/v1/claimed_client_ids${query ? '?' + query : ''}`;
}

async function fetchLinkedDevices(steamId, session) {
  const url = supabaseClaimedIdsUrl(
    `steam_id=eq.${encodeURIComponent(steamId)}&order=claimed_at.desc`,
  );
  const r = await fetch(url, { headers: supabaseHeaders(session) });
  if (!r.ok) throw new Error(`Lookup failed: HTTP ${r.status}`);
  return await r.json();
}

async function claimDevice(clientId, steamId, session) {
  const r = await fetch(supabaseClaimedIdsUrl(''), {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ client_id: clientId, steam_id: steamId }),
  });
  if (r.status === 409) throw new Error('This UUID has already been claimed.');
  if (!r.ok) throw new Error(`Claim failed: HTTP ${r.status}`);
}

async function unclaimDevice(clientId, steamId, session) {
  const url = supabaseClaimedIdsUrl(
    `client_id=eq.${encodeURIComponent(clientId)}&steam_id=eq.${encodeURIComponent(steamId)}`,
  );
  const r = await fetch(url, {
    method: 'DELETE',
    headers: supabaseHeaders(session, { Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error(`Unclaim failed: HTTP ${r.status}`);
}

async function fetchMyUserConfigsMulti(clientIds, session) {
  if (!clientIds || clientIds.length === 0) return [];
  const inList = clientIds.join(',');
  const url = `${SUPABASE_URL}/rest/v1/user_configs`
    + `?client_id=in.(${inList})`
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
  const configTypeSelect = document.getElementById('config-type');

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
    if (configTypeSelect) configTypeSelect.value = localStorage.getItem(CONFIG_TYPE_KEY) || '';
    loadMyHardware();
    renderMyHwSource();
    renderMyHwFieldOrigins();

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

  configTypeSelect?.addEventListener('change', () => {
    const value = configTypeSelect.value || '';
    if (value) localStorage.setItem(CONFIG_TYPE_KEY, value);
    else localStorage.removeItem(CONFIG_TYPE_KEY);
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
            <span class="profile-systems-default-text">${r.is_default ? 'Default' : ''}</span>
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
      let rows = await listUserSystems(steamId, s);
      const genericRows = rows.filter((row) => isGenericSystemLabel(row.label));
      if (genericRows.length) {
        await Promise.allSettled(genericRows.map((row) => {
          const nextLabel = inferSystemLabel(row);
          return updateSystemLabel(steamId, row.device_id, nextLabel, s);
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
    const steamId = getSteamIdFromSession(s);
    if (!steamId) return;

    try {
      if (defToggle) {
        // defToggle.checked is the state AFTER the click. true = user is
        // turning the default ON for this system; false = they flipped OFF
        // the only checked toggle and want no default at all
        if (defToggle.checked) {
          await setDefaultSystem(steamId, deviceId, s);
          await refreshSystems();
          const row = systemsCache.find(r => r.device_id === deviceId);
          if (row) askReplaceLocalFrom(row);
          setMyHardwarePane('local');
        } else {
          await clearDefaultSystem(steamId, s);
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
      const currentRow = systemsCache.find((row) => row.device_id === deviceId);
      const nextLabel = input.value.trim() || inferSystemLabel(currentRow || {});
      input.value = nextLabel;
      await updateSystemLabel(steamId, deviceId, nextLabel, s);
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
  const linkedDevicesList    = document.getElementById('linked-devices-list');
  const linkedDevicesEmpty   = document.getElementById('linked-devices-empty');
  const linkedDevicesLoading = document.getElementById('linked-devices-loading');
  const linkedDevicesStatus  = document.getElementById('linked-devices-status');
  const linkedDevicesRefresh = document.getElementById('linked-devices-refresh-btn');
  const claimDeviceInput     = document.getElementById('claim-device-input');
  const claimDeviceBtn       = document.getElementById('claim-device-btn');
  const claimDeviceStatus    = document.getElementById('claim-device-status');

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
      const protonPulseUserId = getProtonPulseUserIdFromSession(s);
      const cid  = getWebClientIdProfile();
      const rows = await fetchMyUserConfigs(protonPulseUserId, cid, s);
      renderMyConfigs(rows);
    } catch (e) {
      myConfigsLoading.hidden = true;
      showMyConfigsStatus(e.message || 'Failed to load', false);
    }
  }

  myConfigsRefresh?.addEventListener('click', () => { void refreshMyConfigs(); });

  void refreshMyConfigs();

  // ── Linked plugin devices ─────────────────────────────────────────────────
  function renderLinkedDevices(rows) {
    if (!linkedDevicesLoading || !linkedDevicesEmpty || !linkedDevicesList) return;
    linkedDevicesLoading.hidden = true;
    if (!rows || rows.length === 0) {
      linkedDevicesList.hidden  = true;
      linkedDevicesEmpty.hidden = false;
      return;
    }
    linkedDevicesEmpty.hidden = true;
    linkedDevicesList.hidden  = false;
    linkedDevicesList.innerHTML = `
      <table class="profile-configs-table">
        <thead>
          <tr><th>Device UUID</th><th>Claimed</th><th class="col-action"></th></tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr data-client-id="${escapeHtml(row.client_id)}">
              <td><code class="profile-uid" style="font-size:0.78rem">${escapeHtml(row.client_id)}</code></td>
              <td>${escapeHtml(formatSystemUpdated(row.claimed_at))}</td>
              <td class="col-action">
                <button type="button" class="profile-systems-trash" data-role="unclaim" title="Remove">x</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function showLinkedDevicesStatus(msg, ok) {
    if (!linkedDevicesStatus) return;
    linkedDevicesStatus.textContent = msg;
    linkedDevicesStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { linkedDevicesStatus.textContent = ''; }, 3000);
  }

  function showClaimStatus(msg, ok) {
    if (!claimDeviceStatus) return;
    claimDeviceStatus.textContent = msg;
    claimDeviceStatus.style.color = ok ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { claimDeviceStatus.textContent = ''; }, 3000);
  }

  async function refreshLinkedDevices() {
    if (!linkedDevicesLoading) return;
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) {
      linkedDevicesLoading.hidden = true;
      if (linkedDevicesEmpty) {
        linkedDevicesEmpty.hidden = false;
        linkedDevicesEmpty.textContent = 'Sign in with Steam to see your linked devices.';
      }
      return;
    }
    linkedDevicesLoading.hidden = false;
    if (linkedDevicesEmpty) linkedDevicesEmpty.hidden = true;
    try {
      const rows = await fetchLinkedDevices(steamId, s);
      renderLinkedDevices(rows);
    } catch (e) {
      linkedDevicesLoading.hidden = true;
      showLinkedDevicesStatus(e.message || 'Failed to load linked devices', false);
    }
  }

  linkedDevicesRefresh?.addEventListener('click', () => { void refreshLinkedDevices(); });

  linkedDevicesList?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-role="unclaim"]');
    if (!btn) return;
    const tr = btn.closest('tr[data-client-id]');
    if (!tr) return;
    const clientId = tr.dataset.clientId;
    if (!window.confirm('Remove this linked device? Reports from it will no longer appear in My uploaded reports.')) return;
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) return;
    try {
      await unclaimDevice(clientId, steamId, s);
      showClaimStatus('Device unlinked', true);
      await refreshLinkedDevices();
      await refreshMyConfigs();
    } catch (e) {
      showClaimStatus(e.message || 'Failed to unlink', false);
    }
  });

  claimDeviceBtn?.addEventListener('click', async () => {
    const clientId = (claimDeviceInput?.value || '').trim();
    if (!clientId) { showClaimStatus('Paste your plugin UUID first', false); return; }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      showClaimStatus("That doesn't look like a valid UUID", false);
      return;
    }
    const s = await SupaAuth.getSession();
    const steamId = getSteamIdFromSession(s);
    if (!steamId) { showClaimStatus('Sign in first', false); return; }
    try {
      await claimDevice(clientId, steamId, s);
      if (claimDeviceInput) claimDeviceInput.value = '';
      showClaimStatus('Device linked!', true);
      await refreshLinkedDevices();
      await refreshMyConfigs();
    } catch (e) {
      showClaimStatus(e.message || 'Claim failed', false);
    }
  });

  void refreshLinkedDevices();

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
