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

import { dataUrl } from '../../lib/data-url.js?v=3c2e7ac9';

let _cache = null;
let _pending = null;

/**
 * Load + memoize the anti-cheat table. Never throws -- a missing or 404
 * response resolves to an empty {} so callers can stay optimistic and skip
 * the badge/chip when no data is available for this build.
 */
export async function loadAntiCheatMap() {
  if (_cache !== null) return _cache;
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const url = await dataUrl('anti-cheat.json');
      const res = await fetch(url);
      if (!res.ok) return {};
      const data = await res.json();
      return (data && typeof data === 'object') ? data : {};
    } catch {
      return {};
    }
  })().then((m) => { _cache = m; _pending = null; return m; });
  return _pending;
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
 *   - "unknown": Planned (promised but unverified) or missing
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
