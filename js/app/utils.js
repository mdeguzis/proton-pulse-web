// Pure helper functions for the app page (formatting, escaping, small data shaping).
// Moved verbatim from app.js.

/**
 * Normalizes a raw OS version string into a short, human-readable label.
 *
 * Strips parenthetical suffixes, edition/variant words (LTS, Holo, Core, etc.),
 * long build-version segments, and trailing patch numbers. Returns an empty
 * string when the input is numeric-only (e.g. a raw build number) or falsy.
 *
 * @param {string|null|undefined} raw - Raw OS string from a report or sysinfo dump.
 * @returns {string} Cleaned OS label, or '' if nothing useful remains.
 */
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

/**
 * Reduces a list of report rows to one row per app, keeping the most recently
 * updated entry. Accepts both snake_case (`app_id`) and camelCase (`appId`) keys.
 *
 * @param {Array<Object>} rows - Report rows, each with an app identifier and timestamp fields.
 * @returns {Array<Object>} Deduplicated rows, one per unique app ID.
 */
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

/**
 * Races a promise against a timer, resolving with `fallback` if the timer wins.
 *
 * @template T
 * @param {Promise<T>} promise - The operation to race.
 * @param {number} ms - Timeout in milliseconds.
 * @param {T} fallback - Value returned when the timeout fires first.
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

// - Data fetching ------------------------------------

/**
 * Reduces a list of vote/config rows to one row per voter/client, keeping the
 * most recently updated entry. Falls back to a random key for rows without a
 * stable voter_id or clientId, so they are never collapsed together.
 *
 * @param {Array<Object>} rows - Rows with optional `voter_id`, `config.clientId`, and `updated_at`.
 * @returns {Array<Object>} Deduplicated rows, one per client.
 */
export function latestPerClient(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.voter_id || row.config?.clientId || Math.random();
    const existing = seen.get(key);
    if (!existing || row.updated_at > existing.updated_at) seen.set(key, row);
  }
  return [...seen.values()];
}

/**
 * Converts a ProtonDB play-duration enum value to a human-readable string.
 *
 * @param {string} d - Enum value ('underOneHour' | 'oneToFourHours' | 'fourToTenHours' | 'overTenHours').
 * @returns {string|null} Display label, or the raw value if unrecognized, or null if falsy.
 */
export function fmtDuration(d) {
  switch (d) {
    case 'underOneHour':   return '< 1 hour';
    case 'oneToFourHours': return '1-4 hours';
    case 'fourToTenHours': return '4-10 hours';
    case 'overTenHours':   return '10+ hours';
    default:               return d || null;
  }
}

/**
 * Formats a playtime value in minutes to a short display string.
 *
 * Returns '< 1 min' for zero/falsy, minutes for values under 60, and hours
 * (one decimal place below 10 hr, rounded above) for larger values.
 *
 * @param {number} m - Playtime in minutes.
 * @returns {string}
 */
export function fmtMinutes(m) {
  if (!m || m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 10 ? `${h.toFixed(1)} hr` : `${Math.round(h)} hr`;
}

/**
 * Builds a short deduplication key for a ProtonDB report object.
 * Combines timestamp, first 20 chars of GPU string, and first 15 chars of
 * Proton version to catch near-duplicate submissions without requiring an ID.
 *
 * @param {Object} r - Report object with `timestamp`, `gpu`, and `protonVersion` fields.
 * @returns {string}
 */
export function reportKey(r) {
  return `${r.timestamp}:${(r.gpu||'').slice(0,20)}:${(r.protonVersion||'').slice(0,15)}`;
}




/**
 * Returns a human-readable relative time string for a Unix timestamp.
 *
 * @param {number} ts - Unix timestamp in seconds.
 * @returns {string} 'today', '1 day ago', or 'N days ago'.
 */
export function daysAgo(ts) {
  const d = Math.round((Date.now() / 1000 - ts) / 86400);
  return d < 1 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}

/**
 * Formats a Unix timestamp as a UTC datetime string ('YYYY-MM-DD HH:MM:SS UTC').
 *
 * @param {number} ts - Unix timestamp in seconds.
 * @returns {string}
 */
export function utcStamp(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Returns a background color for a confidence score badge.
 *
 * Colors stay in the Steam cyan/blue family so they never visually conflict
 * with tier badge colors (gold, silver, bronze, red). Brightness scales with
 * the score so lower confidence reads as visually muted.
 *
 * @param {number} s - Confidence score (0-10).
 * @returns {string} CSS color hex string.
 */
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
/**
 * Returns an accessible text color to pair with {@link confColor} at a given score.
 *
 * Dark text on bright cyan (score >= 7); light text on darker shades below that.
 *
 * @param {number} s - Confidence score (0-10).
 * @returns {string} CSS color hex string.
 */
export function confTextColor(s) {
  return s >= 7 ? '#0a1a24' : '#e8f4ff';
}

/**
 * Truncates a string to `n` characters, appending '...' if it was cut.
 *
 * @param {string} s
 * @param {number} n - Max character length before truncation.
 * @returns {string}
 */
export function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '...' : s; }

/**
 * HTML-escapes a string using the browser's built-in text encoder.
 * Safe for inserting untrusted content into innerHTML contexts.
 *
 * @param {string} s
 * @returns {string} HTML-escaped string.
 */
export function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

/**
 * #22: Escape a string AND render {spoiler}...{/spoiler} markers as
 * tap-to-reveal blurred spans. Everything outside a spoiler is escaped
 * normally so the helper is safe to use anywhere esc() was used before.
 *
 * Unclosed spoilers fall back to plain escaped text so a reporter who
 * forgets the closing tag does not see a giant blurred tail across the
 * whole notes block.
 *
 * Click toggles the .revealed class on the span. Keyboard activation
 * works via tabindex + Enter/Space because the inline onclick mirror is
 * fired by the synthetic event.
 *
 * @param {string|null|undefined} s
 * @returns {string} HTML string with spoiler spans + escaped plain text.
 */
export function escWithSpoilers(s) {
  if (!s) return '';
  const text = String(s);
  const SPOILER_RE = /\{spoiler\}([\s\S]*?)\{\/spoiler\}/gi;
  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = SPOILER_RE.exec(text)) !== null) {
    out += esc(text.slice(lastIndex, m.index));
    const inner = esc(m[1]);
    // tap or focus+Enter to reveal. Inline JS keeps this self-contained
    // without needing a separate delegated handler.
    const onclick = "this.classList.toggle('revealed')";
    const onkey = "if(event.key==='Enter'||event.key===' '){event.preventDefault();this.classList.toggle('revealed');}";
    out += `<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler -- tap to reveal" onclick="${onclick}" onkeydown="${onkey}"><span class="spoiler-content">${inner}</span></span>`;
    lastIndex = SPOILER_RE.lastIndex;
  }
  out += esc(text.slice(lastIndex));
  return out;
}

// #153 rollout: render Notes text through markdown-it, then post-process
// {spoiler}...{/spoiler} tokens in the resulting HTML. markdown-it is
// loaded from CDN in submit.html + app.html; when it is not available
// (older cached page, test env) we fall back to escWithSpoilers so
// spoilers still work.
let _mdInstance = null;
function _getMdRenderer() {
  if (_mdInstance) return _mdInstance;
  if (typeof window !== 'undefined' && typeof window.markdownit === 'function') {
    // html:false removes the primary XSS surface -- users cannot inject
    // raw HTML through the Notes field. linkify + breaks match GitHub-
    // style behaviour so URLs and hard line breaks Just Work.
    _mdInstance = window.markdownit({
      html: false,
      linkify: true,
      breaks: true,
      typographer: false,
    });
    const defaultRender = _mdInstance.renderer.rules.link_open || function (tokens, idx, options, _env, self) { return self.renderToken(tokens, idx, options); };
    _mdInstance.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultRender(tokens, idx, options, env, self);
    };
  }
  return _mdInstance;
}

/**
 * Render a Notes string as HTML: markdown (via markdown-it) + spoiler
 * tokens post-processed to reveal spans.
 *
 * Known limitation: {spoiler} tokens inside fenced code blocks are still
 * substituted (string-level replace runs on the rendered HTML). A
 * markdown-it plugin would fix that; the string approach is fine for
 * the current spike scope.
 *
 * @param {string|null|undefined} text - Raw Notes value from user_configs.
 * @returns {string} HTML string, safe to drop into innerHTML.
 */
export function renderNotes(text) {
  if (!text) return '';
  const md = _getMdRenderer();
  if (!md) return escWithSpoilers(text);
  let html = md.render(String(text));
  // markdown-it with html:false already escaped the inner text, so we
  // can drop it into the spoiler span without additional escaping.
  const SPOILER_RE = /\{spoiler\}([\s\S]*?)\{\/spoiler\}/gi;
  html = html.replace(
    SPOILER_RE,
    (_full, inner) =>
      `<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler -- tap to reveal" onclick="this.classList.toggle('revealed')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.classList.toggle('revealed');}"><span class="spoiler-content">${inner}</span></span>`,
  );
  return html;
}



// - Render: Proton Pulse Configs section ------------

/** Styled "Not available" placeholder for empty config fields. */
export const NA_SPAN = '<span style="color:#4a5f70;font-style:italic">Not available</span>';

/**
 * Returns the value if truthy, or the {@link NA_SPAN} placeholder HTML.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
export function cfgNa(s) { return s || NA_SPAN; }

/**
 * Triggers a browser download of `obj` serialized as pretty-printed JSON.
 * The filename is `<prefix>.json` with non-filename-safe characters replaced by '_'.
 *
 * @param {Object} obj - Data to serialize.
 * @param {string} prefix - Base name for the downloaded file (without extension).
 */
export function downloadJson(obj, prefix) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${prefix}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Derives a stable string key for a config object, preferring `configId` over `clientId`.
 *
 * @param {Object} c - Config object with optional `configId` and `clientId` fields.
 * @returns {string} Key in the form 'cfg:<id>'.
 */
export function configKey(c) {
  return `cfg:${c.configId != null ? c.configId : (c.clientId || '')}`;
}

/**
 * Hashes a string to a short 7-char hex identifier using the djb2 algorithm.
 * Used to generate stable, URL-safe IDs from report key strings without a crypto dependency.
 *
 * @param {string} s - Input string (typically from {@link reportKey}).
 * @returns {string} 'h' followed by up to 7 lowercase hex characters.
 */
export function hashReportKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(16).slice(0, 7);
}

