// Anti-cheat lookup (#242).
//
// Reads data/anti-cheat.json published nightly by the pipeline. Format:
//   { "<steamAppId>": { "status": "supported"|"running"|"broken"|"denied"|"planned",
//                       "vendors": ["Easy Anti-Cheat", ...] } }
//
// Data source: AreWeAntiCheatYet/AreWeAntiCheatYet (CC-BY). This module is
// tiny on purpose -- the frontend just needs a memoized fetch + a status
// bucket helper so filter chips and badges do not each hard-code the
// upstream vocabulary.

import { dataUrl } from '../../lib/data-url.js?v=9ba434e3';
import { esc } from '../utils.js?v=4630c3d5';

let _cache = null;
let _pending = null;

/**
 * Load + memoize the anti-cheat table. Never throws -- a missing or 404
 * response resolves to an empty {} so callers can stay optimistic and skip
 * the badge/chip when no data is available for this build. Failures are
 * logged with the source so an empty map is distinguishable in the console.
 */
export async function loadAntiCheatMap() {
  if (_cache !== null) return _cache;
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const url = await dataUrl('anti-cheat.json');
      const res = await fetch(url);
      if (!res.ok) {
        console.debug('[anti-cheat] no data', { status: res.status, url, source: 'anti-cheat.json' });
        return {};
      }
      const data = await res.json();
      return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    } catch (err) {
      console.warn('[anti-cheat] load failed', { error: String(err), source: 'anti-cheat.json' });
      return {};
    }
  })().then((m) => { _cache = m; _pending = null; return m; });
  return _pending;
}

/**
 * Synchronous lookup against the already-loaded map (#556). Returns null
 * until loadAntiCheatMap() has resolved, so pages that render cards await
 * the loader alongside their own data first. Used by renderGameCard so
 * every card surface gets the chip without threading status through each
 * call site.
 */
export function antiCheatForAppSync(appId) {
  if (!_cache || appId == null) return null;
  return _cache[String(appId)] || null;
}

/**
 * Return the entry for one Steam appId or null if we do not have data for it.
 */
export async function getAntiCheatForApp(appId) {
  const map = await loadAntiCheatMap();
  return map[String(appId)] || null;
}

/**
 * Bucket the AreWeAntiCheatYet vocabulary into three site-facing labels:
 *   - "works":   Supported (officially runs) or Running (unofficial success)
 *   - "broken":  Broken or Denied (dev refused to enable)
 *   - "unknown": Planned, missing, or null (Steam appdetails scan detected
 *                a vendor but AreWeAntiCheatYet has no Linux verdict yet)
 *
 * Callers use the bucket for filter chips + badge coloring so a future
 * upstream vocabulary change stays contained in one map.
 */
export function bucketAntiCheatStatus(status) {
  if (status === 'supported' || status === 'running') return 'works';
  if (status === 'broken' || status === 'denied') return 'broken';
  return 'unknown';
}

const _WORKS_LABEL = {
  supported: 'Supported on Linux',
  running: 'Running (unofficial)',
};
const _BROKEN_LABEL = {
  broken: 'Blocked on Linux',
  denied: 'Denied by developer',
};

/**
 * Human copy for the tooltip / modal row so we do not shove the raw enum
 * value into user-facing UI.
 */
export function humanAntiCheatStatus(status) {
  return _WORKS_LABEL[status] || _BROKEN_LABEL[status] || (status === 'planned' ? 'Planned' : 'Unknown');
}

// #556: game-page wording, one entry per upstream status. A report rating
// says how well a game runs; anti-cheat decides whether online play works
// on Linux at all. The copy keeps the two apart so a Gold game with blocked
// anti-cheat does not read as "online works".
const _NOTICE = {
  broken: {
    label: 'Blocked on Linux',
    detail: "Online play probably won't work, whatever the rating says.",
  },
  denied: {
    label: 'Denied by the developer',
    detail: "The developer chose not to allow Linux, so online play won't work, whatever the rating says.",
  },
  supported: {
    label: 'Supported on Linux',
    detail: 'The developer enabled it for Proton, so online play should work.',
  },
  running: {
    label: 'Works, unofficially',
    detail: 'Online play works today without official support, so a game update can break it.',
  },
  planned: {
    label: 'Linux support planned',
    detail: "Until it ships, online play may not work.",
  },
};

/**
 * Build the game-page anti-cheat notice for one entry, or null when there is
 * nothing to say. Absence of an entry means "no data", never "no anti-cheat".
 * @param {{status?: string|null, vendors?: string[]|null}|null} entry
 * @returns {{tone: 'works'|'broken'|'unknown', label: string, vendors: string[], detail: string, source: 'awacy'|'steam'}|null}
 */
export function antiCheatNotice(entry) {
  if (!entry) return null;
  const vendors = Array.isArray(entry.vendors) ? entry.vendors.filter(Boolean).map(String) : [];
  const status = entry.status || null;
  const copy = status ? _NOTICE[status] : null;
  if (copy) {
    return { tone: bucketAntiCheatStatus(status), label: copy.label, vendors, detail: copy.detail, source: 'awacy' };
  }
  // Vendor-only: the Steam store page names an anti-cheat but there is no
  // Linux verdict yet (appdetails scan, #242 followup).
  if (!status && vendors.length) {
    return {
      tone: 'unknown',
      label: 'Uses anti-cheat',
      vendors,
      detail: 'There is no Linux verdict yet, so check before counting on online play.',
      source: 'steam',
    };
  }
  return null;
}

/**
 * True when anti-cheat keeps online play from working on Linux. Cards only
 * flag this case (#556): it is the one that contradicts a good rating.
 */
export function antiCheatBlocksLinux(entry) {
  return !!entry && bucketAntiCheatStatus(entry.status) === 'broken';
}

/**
 * Game-page line under the rating panel (#556). Empty string when there is no
 * notice, so the caller can leave the slot hidden.
 * @param {ReturnType<typeof antiCheatNotice>} notice
 * @returns {string}
 */
export function renderAntiCheatLine(notice) {
  if (!notice) return '';
  const vendors = notice.vendors.length ? ` (${esc(notice.vendors.join(', '))})` : '';
  const source = notice.source === 'awacy'
    ? 'Source: <a href="https://areweanticheatyet.com/" target="_blank" rel="noopener">AreWeAntiCheatYet</a>.'
    : 'Detected from the Steam store page.';
  return `<div class="grp-ac grp-ac--${esc(notice.tone)}">`
    + `<div class="grp-ac-head">Anti-cheat: <strong>${esc(notice.label)}</strong>${vendors}</div>`
    + `<div class="grp-ac-detail">${esc(notice.detail)}</div>`
    + `<div class="grp-ac-note">The rating covers how the game runs. Anti-cheat is a separate check. ${source}</div>`
    + '</div>';
}

// #242 home filter. Four keys, multi-select like the Deck chips, so "hide
// blocked games" is works + unknown + none rather than its own option:
//   works    Supported or Running
//   blocked  Broken or Denied
//   unknown  Planned, or a vendor detected with no Linux verdict yet
//   none     no entry: no anti-cheat, or not tracked by AreWeAntiCheatYet.
//            Absence is not proof of no anti-cheat, hence "Not listed".
export const ANTI_CHEAT_FILTER_KEYS = ['works', 'blocked', 'unknown', 'none'];

/**
 * Filter bucket for one anti-cheat.json entry (or null).
 * @param {{status?: string|null, vendors?: string[]|null}|null} entry
 * @returns {'works'|'blocked'|'unknown'|'none'}
 */
export function antiCheatFilterKey(entry) {
  if (!entry) return 'none';
  const vendors = Array.isArray(entry.vendors) ? entry.vendors.filter(Boolean) : [];
  if (!entry.status && !vendors.length) return 'none';
  const bucket = bucketAntiCheatStatus(entry.status);
  return bucket === 'broken' ? 'blocked' : bucket;
}

/**
 * Does an entry pass the selected filter keys? An empty selection, or one
 * containing 'all', passes everything.
 * @param {{status?: string|null, vendors?: string[]|null}|null} entry
 * @param {Set<string>} sel
 */
export function matchesAntiCheatFilter(entry, sel) {
  if (!sel || sel.size === 0 || sel.has('all')) return true;
  return sel.has(antiCheatFilterKey(entry));
}

/**
 * Steam appids from a loaded map whose bucket is in sel. Feeds the home
 * browse pool so "Works on Linux" lists the whole catalog slice instead of
 * whichever of those games happen to be in the top-55 chart.
 * @param {Record<string, object>} map
 * @param {Set<string>} sel
 * @returns {string[]}
 */
export function antiCheatAppIdsMatching(map, sel) {
  if (!map || !sel || sel.size === 0 || sel.has('all')) return [];
  return Object.keys(map).filter((id) => /^\d+$/.test(id) && sel.has(antiCheatFilterKey(map[id])));
}
