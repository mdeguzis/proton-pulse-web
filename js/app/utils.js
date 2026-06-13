// Pure helper functions for the app page (formatting, escaping, small data shaping).
// Moved verbatim from app.js.

export function normalizeOs(raw) {
  if (!raw) return '';
  let s = raw.trim();
  if (/^\d+$/.test(s)) return '';
  // strip parenthetical suffixes
  s = s.replace(/\s*\(.*\)$/, '');
  // strip trailing edition/variant words
  s = s.replace(/\s+(LTS|Holo|Core|Silverblue|Kinoite|Workstation|Server|Desktop)$/i, '');
  // collapse long build versions like "44.20260407.n.0" to just "44"
  s = s.replace(/\s(\d{1,3})\.\d{5,}[\w.]*/g, ' $1');
  // "24.04.3" -> "24.04"
  s = s.replace(/(\d+\.\d+)\.\d+/g, '$1');
  return s.trim();
}

// - Routing ------------------------------------------


export function latestPerApp(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.app_id || row.appId || '');
    if (!key) continue;
    const existing = seen.get(key);
    const rowTime = row.updated_at || row.created_at || '';
    const existingTime = existing?.updated_at || existing?.created_at || '';
    if (!existing || rowTime > existingTime) seen.set(key, row);
  }
  return [...seen.values()];
}

export function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// - Data fetching ------------------------------------

export function latestPerClient(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.voter_id || row.config?.clientId || Math.random();
    const existing = seen.get(key);
    if (!existing || row.updated_at > existing.updated_at) seen.set(key, row);
  }
  return [...seen.values()];
}

export function fmtDuration(d) {
  switch (d) {
    case 'underOneHour':   return '< 1 hour';
    case 'oneToFourHours': return '1-4 hours';
    case 'fourToTenHours': return '4-10 hours';
    case 'overTenHours':   return '10+ hours';
    default:               return d || null;
  }
}

export function fmtMinutes(m) {
  if (!m || m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 10 ? `${h.toFixed(1)} hr` : `${Math.round(h)} hr`;
}

export function reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
}




export function daysAgo(ts) {
  const d = Math.round((Date.now() / 1000 - ts) / 86400);
  return d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

export function utcStamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function confColor(s) {
  // Confidence always lives in the Steam-cyan/blue family so it can never
  // blend with a rating badge color (gold / silver / bronze / borked-red).
  // Brightness drops as confidence drops - the percentage number still
  // does the heavy lifting; the color just signals "this is confidence, not
  // a tier badge" at a glance.
  if (s >= 8) return '#66c0f4';   // Steam accent cyan - high confidence
  if (s >= 6) return '#4a90b8';   // mid cyan - moderate
  if (s >= 4) return '#3a6680';   // muted dark cyan - low
  return '#4a5a6a';                // slate-grey - very low
}
// Text color paired with confColor - dark text on bright cyan reads fine, but
// the darker cyan / slate shades need light text for accessibility
export function confTextColor(s) {
  return s >= 7 ? '#0a1a24' : '#e8f4ff';
}

export function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

export function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }






// - Render: Proton Pulse Configs section ------------

export const NA_SPAN = '<span style="color:#4a5f70;font-style:italic">Not available</span>';
export function cfgNa(s) { return s || NA_SPAN; }

export function downloadJson(obj, prefix) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

export function configKey(c) {
  return `cfg:${c.configId != null ? c.configId : (c.clientId || '')}`;
}

export function hashReportKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(16).slice(0, 7);
}
