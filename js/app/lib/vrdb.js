// VRDB lookup (#246).
//
// Reads vrdb.json published by the pipeline from github.com/Respuit/VRDB (MIT),
// the community VR-on-Linux database behind db.vronlinux.org. Format:
//   { generated_at, source, site, license, ratings: {"1": "Perfect", ...},
//     games: { "<steamAppId>": { title, reports, runtimes: {
//                <runtime>: { count, best, worst } }, devices: [...], latest } } }
//
// Their scale is 1-5 where LOWER IS BETTER, the inverse of a Pulse tier. This
// data is display-only context and never feeds tier or confidence math -- it
// is somebody else's methodology on somebody else's sample, shown with
// attribution alongside ours rather than blended into it.

import { dataUrl } from '../../lib/data-url.js?v=0de73aed';

let _cache = null;
let _pending = null;

/**
 * Load + memoize the VRDB payload. Never throws -- a missing or 404 response
 * resolves to an empty payload so the game page just renders no VR panel.
 * @returns {Promise<{games: object, ratings: object, source: string, site: string, generated_at: string}>}
 */
export async function loadVrdb() {
  if (_cache !== null) return _cache;
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const url = await dataUrl('vrdb.json');
      const res = await fetch(url);
      if (!res.ok) {
        console.debug('[vrdb] no data', { status: res.status, url, source: 'vrdb.json' });
        return _emptyPayload();
      }
      const data = await res.json();
      if (!data || typeof data !== 'object' || typeof data.games !== 'object') {
        console.warn('[vrdb] unexpected payload shape', { keys: data && Object.keys(data), source: 'vrdb.json' });
        return _emptyPayload();
      }
      return data;
    } catch (err) {
      console.warn('[vrdb] load failed', { error: String(err), source: 'vrdb.json' });
      return _emptyPayload();
    }
  })().then((p) => { _cache = p; _pending = null; return p; });
  return _pending;
}

function _emptyPayload() {
  return { games: {}, ratings: {}, source: '', site: '', generated_at: '' };
}

/**
 * VRDB entry for one Steam appId, or null when they have no reports for it.
 * Non-Steam ids (gog:/epic:/pgwiki:) always return null -- VRDB is keyed on
 * Steam appids only.
 * @param {string|number} appId
 * @returns {Promise<object|null>}
 */
export async function getVrdbForApp(appId) {
  const id = String(appId == null ? '' : appId).trim();
  if (!/^\d+$/.test(id)) return null;
  const payload = await loadVrdb();
  const entry = payload.games[id];
  if (!entry) return null;
  return { ...entry, _source: payload.source, _site: payload.site, _ratings: payload.ratings };
}

/**
 * Best (lowest) rating across every runtime in an entry, for a one-line
 * summary. Returns null when nothing is rated.
 * @param {object} entry - A VRDB game entry.
 * @returns {{runtime: string, rating: number}|null}
 */
export function bestVrdbRuntime(entry) {
  const runtimes = entry?.runtimes;
  if (!runtimes || typeof runtimes !== 'object') return null;
  let best = null;
  for (const [runtime, stats] of Object.entries(runtimes)) {
    const rating = Number(stats?.best);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue;
    if (!best || rating < best.rating) best = { runtime, rating };
  }
  return best;
}
