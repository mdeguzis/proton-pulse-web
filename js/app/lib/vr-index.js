// VR capability lookup (#246).
//
// Reads vr-index.json published by the pipeline: a compact
//   { "<steamAppId>": "supported" | "only" }
// map covering every game flagged VR by Steam store categories or by the VRDB
// catalog.
//
// The search API returns `vr` per row already, so this file exists for the
// surfaces that do NOT go through it: the home page builds its rows from
// most_played.json / recent-reports.json, and those carry no VR field. Same
// shape and memoization as anti-cheat.js.

import { dataUrl } from '../../lib/data-url.js?v=0de73aed';

let _cache = null;
let _pending = null;

/**
 * Load + memoize the VR capability map. Never throws -- a missing or 404
 * response resolves to {} so cards simply render no VR chip.
 * @returns {Promise<Record<string, string>>}
 */
export async function loadVrIndex() {
  if (_cache !== null) return _cache;
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const url = await dataUrl('vr-index.json');
      const res = await fetch(url);
      if (!res.ok) {
        console.debug('[vr-index] no data', { status: res.status, url, source: 'vr-index.json' });
        return {};
      }
      const data = await res.json();
      return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    } catch (err) {
      console.warn('[vr-index] load failed', { error: String(err), source: 'vr-index.json' });
      return {};
    }
  })().then((m) => { _cache = m; _pending = null; return m; });
  return _pending;
}

/**
 * VR capability for one app: 'supported', 'only', or null.
 *
 * null means "not VR, or not yet checked" -- the flag fills in as the Steam
 * appdetails cache rolls over, so absence is not proof a game lacks VR.
 * @param {Record<string,string>} map - A loaded VR index.
 * @param {string|number} appId
 * @returns {string|null}
 */
export function vrForApp(map, appId) {
  if (!map) return null;
  const v = map[String(appId == null ? '' : appId)];
  return v === 'supported' || v === 'only' ? v : null;
}

/**
 * Does a game pass the given VR filter?
 *
 * Filters mirror the search-games edge fn so the home page and the search API
 * agree on what "VR" means:
 *   'any'  everything
 *   'vr'   any VR title (supported or only)
 *   'only' headset required
 *   'flat' playable on a monitor -- excludes VR-only, keeps everything else
 *
 * @param {string|null} vr - The game's capability.
 * @param {string} filter - One of any | vr | only | flat.
 * @returns {boolean}
 */
export function matchesVrFilter(vr, filter) {
  switch (filter) {
    case 'vr':   return vr === 'supported' || vr === 'only';
    case 'only': return vr === 'only';
    case 'flat': return vr !== 'only';
    default:     return true;
  }
}
