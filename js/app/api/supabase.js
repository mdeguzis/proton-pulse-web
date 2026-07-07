// supabase (api) for the app page. Relocated from app.js.

import { SB_KEY, SB_URL } from '../config.js?v=f9591262';
import { configKey, latestPerClient } from '../utils.js?v=c7e1268c';

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

function computeApprovalHash(row) {
  const parts = [
    String(row.app_id || ''),
    String(row.client_id || ''),
    String(row.rating || ''),
    String(row.notes || ''),
    String(row.os || ''),
    String(row.gpu || ''),
    String(row.created_at || ''),
  ];
  return md5(parts.join('|'));
}

function md5(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476;
  const k = [], s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  for (let i = 0; i < 64; i++) k[i] = Math.floor(2**32 * Math.abs(Math.sin(i + 1))) >>> 0;
  const pad = new Uint8Array(((data.length + 9 + 63) & ~63));
  pad.set(data); pad[data.length] = 0x80;
  const dv = new DataView(pad.buffer);
  dv.setUint32(pad.length - 8, (data.length * 8) >>> 0, true);
  dv.setUint32(pad.length - 4, (data.length * 8 / 2**32) >>> 0, true);
  for (let off = 0; off < pad.length; off += 64) {
    const m = [];
    for (let j = 0; j < 16; j++) m[j] = dv.getUint32(off + j * 4, true);
    let [a, b, c, d] = [h0, h1, h2, h3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5*i+1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3*i+5) % 16; }
      else { f = c ^ (b | ~d); g = (7*i) % 16; }
      f = (f + a + k[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << s[i]) | (f >>> (32 - s[i])))) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
  }
  return [h0, h1, h2, h3].map(v => v.toString(16).padStart(8, '0').replace(/(..)(..)(..)(..)/, '$4$3$2$1')).join('');
}

export async function fetchNativeReports(appId) {
  try {
    const [r, approvalRes] = await Promise.all([
      fetch(
        `${SB_URL}/user_configs?app_id=eq.${appId}&is_flagged=neq.true&select=id,client_id,proton_pulse_user_id,app_id,title,cpu,gpu,gpu_driver,gpu_vendor,gpu_architecture,ram,os,kernel,proton_version,rating,duration,duration_minutes,notes,vram_mb,fps_min,fps_avg,fps_max,run_type,form_responses,config_key,game_owned,owner_verified,created_at,updated_at,source,is_flagged,launch_options&order=created_at.desc`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      ),
      fetch(
        `${SB_URL}/report_approvals?select=report_id,approval_hash`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      ).catch(() => ({ ok: false })),
    ]);
    if (!r.ok) return [];
    const rows = await r.json();
    const approvals = approvalRes.ok ? await approvalRes.json() : [];
    const approvalMap = new Map(approvals.map(a => [a.report_id, a.approval_hash]));

    // Filter to only approved reports (hash matches current content)
    const approvedRows = rows.filter(row => {
      const storedHash = approvalMap.get(row.id);
      if (!storedHash) return false;
      return storedHash === computeApprovalHash(row);
    });
    // keep only the latest submission per client
    const seen = new Map();
    for (const row of approvedRows) {
      const key = row.client_id || Math.random();
      const existing = seen.get(key);
      if (!existing || row.created_at > existing.created_at) seen.set(key, row);
    }
    return [...seen.values()].map(row => ({
      reportId:          row.id ?? null,
      appId:             row.app_id,
      clientId:          row.client_id || '',
      protonPulseUserId: row.proton_pulse_user_id || null,
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
      fpsMin:            row.fps_min ?? null,
      fpsAvg:            row.fps_avg ?? null,
      fpsMax:            row.fps_max ?? null,
      runType:           row.run_type ?? null,
      formResponses:     row.form_responses ?? null,
      configKey:         row.config_key || null,
      gameOwned:         row.game_owned ?? false,
      ownerVerified:     row.owner_verified ?? false,
      timestamp:         Math.floor(new Date(row.created_at).getTime() / 1000),
      updatedAt:         row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : null,
      source:            row.source || 'proton-pulse',
      isFlagged:         row.is_flagged ?? false,
      launchOptions:     row.launch_options || '',
    }));
  } catch { return []; }
}

export async function flagReport({ reportId, appId, reportKey, source, reasonCategory, reasonText, reporterClientId }) {
  // Go through the submit_flag RPC, which upserts on the (app_id, report_key)
  // unique key and re-opens an already-resolved flag. A plain POST hit the
  // unique constraint (409) and never resurfaced reviewed reports.
  const flagRes = await fetch(`${SB_URL}/rpc/submit_flag`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      p_app_id: String(appId),
      p_report_key: reportKey,
      p_source: source || 'unknown',
      p_reason_category: reasonCategory || null,
      p_reason_text: reasonText || null,
      p_reporter_client_id: reporterClientId || null,
    }),
  });
  // Best-effort: mark the underlying Pulse report flagged. Only the owner can
  // do this under RLS, so a failure here must not fail the flag itself -- the
  // flagged_reports row is the source of truth for moderation.
  if (reportId != null) {
    fetch(`${SB_URL}/user_configs?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ is_flagged: true }),
    }).catch(() => {});
  }
  return flagRes.ok;
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
