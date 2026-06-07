// data module for the app page. Relocated from app.js.

import { CDN, SB_KEY, SB_URL } from './config.js';
import { configKey, latestPerClient } from './utils.js';

export async function fetchCdn(appId) {
  try {
    const r = await fetch(`${CDN}/${appId}/latest.json`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Session cache for user-triggered live ProtonDB checks. Keyed by appId so
// repeat visits within the session skip the network hit without auto-fetching.
export const _protonDbLiveCache = new Map();

// User-triggered live check: fetches ProtonDB public API for a single game.
// NOT called automatically -- must be triggered by the user clicking the
// "Check ProtonDB Live" button to avoid hammering their API on every page load.
export async function fetchProtonDbLive(appId) {
  const key = String(appId);
  if (_protonDbLiveCache.has(key)) return _protonDbLiveCache.get(key);
  try {
    const r = await fetch(
      `https://www.protondb.com/api/v1/reports/summaries/${appId}.json`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) { _protonDbLiveCache.set(key, []); return []; }
    const data = await r.json();
    if (!data || !data.tier) { _protonDbLiveCache.set(key, []); return []; }
    console.log(`[proton-pulse] live check for ${appId} | tier=${data.tier} total=${data.total} source=protondb-api`);
    const result = [{
      appId,
      tier:         data.tier,
      total:        data.total || 0,
      trendingTier: data.trendingTier || data.tier,
      score:        data.score || 0,
      source:       'protondb-live',
      _liveOnly:    true,
    }];
    _protonDbLiveCache.set(key, result);
    return result;
  } catch (e) {
    console.debug(`[proton-pulse] ProtonDB live check failed | appId=${appId} error=${e.message}`);
    _protonDbLiveCache.set(key, []);
    return [];
  }
}


/** Deduplicate rows by voter_id, keeping only the most recent per unique client. */

export async function fetchSupabase(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_proton_configs?app_id=eq.${appId}&is_published=eq.true&select=id,voter_id,app_id,app_name,config,updated_at,is_published&order=updated_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = latestPerClient(await r.json());

    return rows.map(row => {
      const cfg = row.config || {};
      return {
        appId:         row.app_id,
        configId:      row.id ?? null,
        clientId:      row.voter_id || cfg.clientId || '',
        profileName:   cfg.profileName || '',
        protonVersion: cfg.protonVersion || '',
        launchOptions: cfg.launchOptions || '',
        enabledVars:   cfg.enabledVars   || {},
        appName:       row.app_name || cfg.appName || `App ${row.app_id}`,
        timestamp:     Math.floor(new Date(row.updated_at).getTime() / 1000),
        source:        cfg.source || 'proton-pulse',
        cpu:           cfg.cpu   || null,
        gpu:           cfg.gpu   || null,
        gpuVendor:     cfg.gpuVendor || null,
        gpuDriver:     cfg.gpuDriver || null,
        ram:           cfg.ram   || null,
        os:            cfg.os    || null,
        kernel:        cfg.kernel || null,
        isNonSteam:    cfg.isNonSteam === true,
        pluginVersion: cfg.pluginVersion || null,
        isEdited:      cfg.isEdited === true,
      };
    });
  } catch { return []; }
}

export async function fetchNativeReports(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/user_configs?app_id=eq.${appId}&select=id,client_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,ram,os,kernel,proton_version,rating,duration,duration_minutes,notes,vram_mb,form_responses,config_key,game_owned,created_at,updated_at,source&order=created_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    const rows = await r.json();
    // keep only the latest submission per client
    const seen = new Map();
    for (const row of rows) {
      const key = row.client_id || Math.random();
      const existing = seen.get(key);
      if (!existing || row.created_at > existing.created_at) seen.set(key, row);
    }
    return [...seen.values()].map(row => ({
      reportId:          row.id ?? null,
      appId:             row.app_id,
      clientId:          row.client_id || '',
      title:             row.title || `App ${row.app_id}`,
      cpu:               row.cpu || '',
      gpu:               row.gpu || '',
      gpuDriver:         row.gpu_driver || '',
      gpuVendor:         row.gpu_vendor || '',
      ram:               row.ram || '',
      os:                row.os || '',
      kernel:            row.kernel || '',
      protonVersion:     row.proton_version || '',
      rating:            row.rating || '',
      duration:          row.duration || '',
      durationMinutes:   row.duration_minutes ?? null,
      notes:             row.notes || '',
      vramMb:            row.vram_mb ?? null,
      formResponses:     row.form_responses ?? null,
      configKey:         row.config_key || null,
      gameOwned:         row.game_owned ?? false,
      timestamp:         Math.floor(new Date(row.created_at).getTime() / 1000),
      updatedAt:         row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : null,
      source:            row.source || 'proton-pulse',
    }));
  } catch { return []; }
}

export async function fetchConfigPlaytimeTotals(appId) {
  try {
    const r = await fetch(
      `${SB_URL}/config_playtime_totals?app_id=eq.${appId}&select=config_key,total_minutes,session_count,unique_players`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
