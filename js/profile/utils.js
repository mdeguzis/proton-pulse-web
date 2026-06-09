// Pure helpers for the profile page: session readers, Steam sysinfo parsing,
// system-label inference, localStorage persistence, HTML escaping, and report
// row shaping. No DOM writes, no fetching.
import {
  SHOW_USERNAME_KEY, MYHW_SOURCE_META_KEY, MYHW_FIELD_ORIGINS_KEY,
  WEB_CLIENT_ID_KEY, FIELD_LABELS,
} from './config.js';

export function getSteamIdFromSession(session) {
  // Steam openid sub is like "https://steamcommunity.com/openid/id/76561198000000000".
  // The Supabase edge function stores it under user_metadata.steam_id (preferred) or
  // provider_id depending on flow. Check both.
  const meta = session?.user?.user_metadata || {};
  return meta.steam_id || meta.provider_id || meta.sub || null;
}

export function getProtonPulseUserIdFromSession(session) {
  return session?.user?.id || null;
}

// localStorage is the fast local read; Supabase user_metadata is the
// authoritative cross-device source. getShowUsername reads local only;
// showUser() syncs the authoritative value down on sign-in.
export function getShowUsername() {
  // Default to true for signed-in Pulse accounts: if the user took the
  // step of linking their Steam account, the assumption is they want their
  // username visible on reports. They can opt out via the toggle, which
  // sets the key to the literal string 'false'.
  const v = localStorage.getItem(SHOW_USERNAME_KEY);
  if (v === null) return true;
  return v === 'true';
}

export function setShowUsername(val) {
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
export function cleanUnknown(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return /^unknown$/i.test(t) ? '' : t;
}

export function parseSteamSystemInfo(text) {
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
export function inferGpuVendor(gpuString) {
  const s = (gpuString || '').toString().toLowerCase();
  if (!s) return '';
  if (/(nvidia|geforce|quadro)/.test(s)) return 'nvidia';
  if (/(amd|radeon|rdna|rx\s*\d|vega)/.test(s)) return 'amd';
  if (/(intel|arc|iris|uhd|xe\b)/.test(s)) return 'intel';
  return '';
}

export function parseUploadedSystem(row) {
  const parsed = parseSteamSystemInfo(row?.sysinfo_text || '');
  if (parsed.gpu && !parsed.gpuVendor) {
    parsed.gpuVendor = inferGpuVendor(parsed.gpu);
  }
  return parsed;
}

export function isGenericSystemLabel(label) {
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
export function inferSystemLabel(rowOrParsed) {
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

export function summarizeSystem(parsed) {
  const bits = [parsed.os, parsed.cpu || parsed.gpu, parsed.ram].filter(Boolean);
  return bits.length ? bits.join(' • ') : 'No parsed hardware summary available yet.';
}
export function getMyHwSourceMeta() {
  try {
    const raw = localStorage.getItem(MYHW_SOURCE_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setMyHwSourceMeta(meta) {
  if (!meta) {
    localStorage.removeItem(MYHW_SOURCE_META_KEY);
    return;
  }
  localStorage.setItem(MYHW_SOURCE_META_KEY, JSON.stringify(meta));
}

export function getMyHwFieldOrigins() {
  try {
    const raw = localStorage.getItem(MYHW_FIELD_ORIGINS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function setMyHwFieldOrigins(origins) {
  if (!origins || Object.keys(origins).length === 0) {
    localStorage.removeItem(MYHW_FIELD_ORIGINS_KEY);
    return;
  }
  localStorage.setItem(MYHW_FIELD_ORIGINS_KEY, JSON.stringify(origins));
}

export function setMyHwFieldOrigin(field, origin) {
  const cur = getMyHwFieldOrigins();
  if (!origin) delete cur[field];
  else cur[field] = origin;
  setMyHwFieldOrigins(cur);
}

// Small helpers pulled out of the page-init IIFE so they can be unit-tested.
// escapeHtml prevents XSS when we drop user-supplied label/device_id into an
// innerHTML template. Keep the char set in sync with the five HTML-unsafe chars
export function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Parse an ISO timestamp and format it in the user's locale. new Date() is
// lenient (null -> epoch, '' -> Invalid Date, neither throws), so we guard
// falsy inputs with a dash and fall back to the raw string on unparseable
// input so the UI never shows "Invalid Date"
export function formatSystemUpdated(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}
export function getWebClientIdProfile() {
  let id = localStorage.getItem(WEB_CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(WEB_CLIENT_ID_KEY, id);
  }
  return id;
}
export function enabledVarsToText(vars) {
  if (!vars || typeof vars !== 'object') return '';
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function textToEnabledVars(text) {
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
export function getMyReportBadges(row) {
  const badges = [];
  if (row.cloud) badges.push({ label: 'Cloud', tone: 'cloud' });
  if (row.published) badges.push({ label: 'Published', tone: 'published' });
  if (row.unpublished) badges.push({ label: 'Unpublished', tone: 'unpublished' });
  if (row.flagged) badges.push({ label: 'Flagged', tone: 'flagged' });
  return badges;
}
export function flaggedMessageHtml(flaggedReason) {
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
export function mergeMyReportRows(publishedRows, cloudRows) {
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
export function getPluginLinkCodeFromLocation(loc = window.location) {
  const searchCode = new URLSearchParams(loc.search || '').get('pluginLinkCode');
  if (searchCode) return searchCode;

  const hash = String(loc.hash || '');
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex === -1) return null;
  const hashQuery = hash.slice(hashQueryIndex + 1);
  return new URLSearchParams(hashQuery).get('pluginLinkCode');
}
