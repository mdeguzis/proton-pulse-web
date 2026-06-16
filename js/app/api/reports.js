// reports (api) for the app page. Relocated from app.js.

import { SB_KEY, SB_URL } from '../config.js?v=9970759a';
import { latestPerApp } from '../utils.js?v=5184cce6';

/**
 * Fetch the 200 most recent Pulse compatibility reports from the `user_configs` table,
 * then deduplicate to one entry per app (most recent per app_id via `latestPerApp`),
 * sorted descending by `created_at`.
 * Hits Supabase REST: `user_configs?select=id,app_id,title,rating,proton_version,created_at,source`.
 * @returns {Promise<Array<object>>} Deduplicated report rows sorted by newest first, or empty array on failure.
 */
export async function fetchRecentPulseReports() {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?select=id,app_id,title,rating,proton_version,created_at,source&order=created_at.desc&limit=200`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    return latestPerApp(await r.json()).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    return [];
  }
}


/**
 * Search published Pulse launch configs from the `user_proton_configs` table.
 * Matches by exact `app_id` when `query` is numeric, or by `app_name` ilike otherwise.
 * Deduplicates to one config per app (newest) and normalises each row into a flat shape.
 * Hits Supabase REST: `user_proton_configs?is_published=eq.true`.
 * @param {string} query - Search string (game name or numeric app ID).
 * @returns {Promise<Array<{appId: number, appName: string, profileName: string, protonVersion: string, updatedAt: string, source: string}>>}
 *   Matched configs (up to 60, deduplicated), or empty array on failure or empty query.
 */
export async function fetchMatchingPulseConfigs(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = new URL(`${SB_URL}/user_proton_configs`);
    url.searchParams.set('select', 'id,voter_id,app_id,app_name,config,updated_at,is_published');
    url.searchParams.set('is_published', 'eq.true');
    url.searchParams.set('order', 'updated_at.desc');
    url.searchParams.set('limit', '60');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},app_name.ilike.*${q}*)`);
    } else {
      url.searchParams.set('app_name', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return [];
    return latestPerApp(await r.json()).map((row) => {
      const cfg = row.config || {};
      return {
        appId: row.app_id,
        appName: row.app_name || cfg.appName || `App ${row.app_id}`,
        profileName: cfg.profileName || 'Unnamed Config',
        protonVersion: cfg.protonVersion || '',
        updatedAt: row.updated_at,
        source: cfg.source || 'proton-pulse',
      };
    });
  } catch {
    return [];
  }
}

// Return distinct app_ids from user_configs (Pulse compatibility reports) that
// match the query. Used to tag search results with the Pulse badge even when
// the game has no saved launch profile yet
/**
 * Return the set of `app_id` values from `user_configs` that match the search query.
 * Used to badge search results with the Pulse indicator even when no launch profile exists.
 * Hits Supabase REST: `user_configs?select=app_id` with title or app_id filter (up to 100 rows).
 * @param {string} query - Search string (game name or numeric app ID).
 * @returns {Promise<Set<string>>} Set of matching app IDs as strings, or empty Set on failure or empty query.
 */
export async function fetchMatchingPulseReportAppIds(query) {
  const q = query.trim();
  if (!q) return new Set();
  try {
    const url = new URL(`${SB_URL}/user_configs`);
    url.searchParams.set('select', 'app_id');
    url.searchParams.set('limit', '100');
    if (/^\d+$/.test(q)) {
      url.searchParams.set('or', `(app_id.eq.${q},title.ilike.*${q}*)`);
    } else {
      url.searchParams.set('title', `ilike.*${q}*`);
    }
    const r = await fetch(url.toString(), {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return new Set();
    const rows = await r.json();
    return new Set(rows.map((row) => String(row.app_id)));
  } catch {
    return new Set();
  }
}
