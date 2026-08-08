// depotTracking (admin api): reads for the Depot Tracking admin panel (#230).
// Pulls three public tables and aggregates them client-side into a single
// per-app dossier so we don't have to open the Actions log or Supabase
// dashboard to answer 'has the tracker seen X yet' style questions.
//
//   steam_depot_fetch_status    -> app-level ok / no_public_manifest / error
//   steam_depot_updates         -> current per-depot state (OS, manifest_id)
//   steam_depot_manifest_history -> observation history (first_seen, count)
//
// Reads use the anon key + public RLS policies -- no service role needed.
// Writes (workflow dispatch, cache invalidation) are out of scope for the
// MVP and will land as a separate signed-in-admin-only edge function in a
// follow-up.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v=ffed3d84';

const REST = `${SUPABASE_URL}/rest/v1`;
const HDR  = { apikey: SUPABASE_ANON_KEY, Accept: 'application/json' };

/**
 * Fetch the per-app status view. Returns an array sorted by fetched_at
 * DESC so the most recently touched apps are on top. Fields:
 *   { app_id, app_status, depot_count, fetched_at, error }
 */
export async function fetchDepotFetchStatus({ limit = 500 } = {}) {
  const url = `${REST}/steam_depot_fetch_status?select=app_id,app_status,depot_count,fetched_at,error&order=fetched_at.desc&limit=${limit}`;
  const r = await fetch(url, { headers: HDR });
  if (!r.ok) throw new Error(`fetch status failed: HTTP ${r.status}`);
  return r.json();
}

/**
 * Fetch current per-depot state for a set of app_ids. Batched into
 * chunks of 100 so a big status page does not trip PostgREST URL length
 * limits. Returns { [app_id]: [{ os, depot_id, manifest_id,
 * last_updated_at, name }, ...] }.
 */
export async function fetchDepotUpdatesForApps(appIds) {
  const out = {};
  if (!Array.isArray(appIds) || appIds.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < appIds.length; i += CHUNK) {
    const chunk = appIds.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    params.set('select', 'app_id,os,depot_id,manifest_id,last_updated_at,name');
    params.append('app_id', `in.(${chunk.join(',')})`);
    params.set('order', 'app_id.asc,os.asc');
    params.set('limit', String(chunk.length * 10));
    const r = await fetch(`${REST}/steam_depot_updates?${params}`, { headers: HDR });
    if (!r.ok) continue;
    const rows = await r.json();
    for (const row of rows) {
      const k = String(row.app_id);
      if (!out[k]) out[k] = [];
      out[k].push(row);
    }
  }
  return out;
}

/**
 * Fetch manifest history counts + newest observation per app in one
 * paginated read. Returns { [app_id]: { manifestCount, newestFirstObserved,
 * oldestFirstObserved, perOs: { linux: { count, newestFirstObserved,
 * oldestFirstObserved }, ... } } }. Aggregation is client-side because
 * PostgREST does not have GROUP BY unless we ship a view or RPC.
 */
export async function fetchManifestHistoryForApps(appIds) {
  const out = {};
  if (!Array.isArray(appIds) || appIds.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < appIds.length; i += CHUNK) {
    const chunk = appIds.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    params.set('select', 'app_id,os,first_observed_at,latest_observed_at');
    params.append('app_id', `in.(${chunk.join(',')})`);
    params.set('limit', '2000');
    const r = await fetch(`${REST}/steam_depot_manifest_history?${params}`, { headers: HDR });
    if (!r.ok) continue;
    const rows = await r.json();
    for (const row of rows) {
      const k = String(row.app_id);
      if (!out[k]) out[k] = { manifestCount: 0, newestFirstObserved: null, oldestFirstObserved: null, perOs: {} };
      const bucket = out[k];
      bucket.manifestCount++;
      const ts = row.first_observed_at;
      if (!bucket.newestFirstObserved || ts > bucket.newestFirstObserved) bucket.newestFirstObserved = ts;
      if (!bucket.oldestFirstObserved || ts < bucket.oldestFirstObserved) bucket.oldestFirstObserved = ts;
      const os = row.os || 'unknown';
      if (!bucket.perOs[os]) bucket.perOs[os] = { count: 0, newestFirstObserved: null, oldestFirstObserved: null };
      const ob = bucket.perOs[os];
      ob.count++;
      if (!ob.newestFirstObserved || ts > ob.newestFirstObserved) ob.newestFirstObserved = ts;
      if (!ob.oldestFirstObserved || ts < ob.oldestFirstObserved) ob.oldestFirstObserved = ts;
    }
  }
  return out;
}

/**
 * One-shot loader for the panel: fetches status + hydrates each row with
 * depots + history. Returns { apps: [{ ...status, depots: [...],
 * history: {...} }], aggregate: { total, ok, noManifest, error, newest,
 * updatedIn24h, updatedIn7d, updatedIn30d } }.
 */
export async function fetchDepotTrackingDossier({ limit = 500 } = {}) {
  const status = await fetchDepotFetchStatus({ limit });
  const appIds = status.map(s => s.app_id);
  const [depots, history] = await Promise.all([
    fetchDepotUpdatesForApps(appIds),
    fetchManifestHistoryForApps(appIds),
  ]);
  const apps = status.map(s => ({
    ...s,
    depots:  depots[String(s.app_id)]  || [],
    history: history[String(s.app_id)] || null,
  }));
  return {
    apps,
    aggregate: summarizeApps(apps),
  };
}

/**
 * Pure aggregation over hydrated app rows. Broken out so the tests do
 * not need a live Supabase to exercise the summary math.
 */
export function summarizeApps(apps) {
  const s = {
    total: apps.length,
    ok: 0,
    noManifest: 0,
    error: 0,
    newest: null,
    updatedIn24h: 0,
    updatedIn7d:  0,
    updatedIn30d: 0,
  };
  if (!apps.length) return s;
  const now = Date.now();
  const DAY = 86400 * 1000;
  for (const a of apps) {
    if (a.app_status === 'ok') s.ok++;
    else if (a.app_status === 'no_public_manifest') s.noManifest++;
    else s.error++;
    if (a.fetched_at && (!s.newest || a.fetched_at > s.newest)) s.newest = a.fetched_at;
    const changeTs = a.history?.newestFirstObserved || null;
    if (changeTs) {
      const diff = now - Date.parse(changeTs);
      if (Number.isFinite(diff)) {
        if (diff <= 1 * DAY)  s.updatedIn24h++;
        if (diff <= 7 * DAY)  s.updatedIn7d++;
        if (diff <= 30 * DAY) s.updatedIn30d++;
      }
    }
  }
  return s;
}
