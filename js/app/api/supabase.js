// supabase (api) for the app page. Relocated from app.js.

import { SB_KEY, SB_URL } from '../config.js?v=4031c5fa';
import { configKey, latestPerClient } from '../utils.js?v=f5dda5b6';

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
      `${SB_URL}/user_configs?app_id=eq.${appId}&is_flagged=neq.true&select=id,client_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,gpu_architecture,ram,os,kernel,proton_version,rating,duration,duration_minutes,notes,vram_mb,form_responses,config_key,game_owned,created_at,updated_at,source,is_flagged&order=created_at.desc`,
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
      gpuArchitecture:   row.gpu_architecture || '',
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
      isFlagged:         row.is_flagged ?? false,
    }));
  } catch { return []; }
}

export async function flagReport({ reportId, appId, reportKey, source, reasonCategory, reasonText, reporterClientId }) {
  const results = await Promise.all([
    fetch(`${SB_URL}/flagged_reports`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        app_id: String(appId),
        report_key: reportKey,
        source: source || 'unknown',
        reason_category: reasonCategory || null,
        reason_text: reasonText || null,
        reporter_client_id: reporterClientId || null,
      }),
    }),
    reportId != null
      ? fetch(`${SB_URL}/user_configs?id=eq.${reportId}`, {
          method: 'PATCH',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ is_flagged: true }),
        })
      : Promise.resolve({ ok: true }),
  ]);
  // 409 = unique constraint (already flagged) -- treat as success
  return results.every(r => r.ok || r.status === 409);
}

export async function fetchMyFlags(clientId) {
  try {
    const r = await fetch(
      `${SB_URL}/flagged_reports?reporter_client_id=eq.${encodeURIComponent(clientId)}&select=id,app_id,source,reason_category,reason_text,status,flagged_at&order=flagged_at.desc`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    return r.ok ? await r.json() : [];
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
