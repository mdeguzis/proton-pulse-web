import { SUPABASE_URL } from '../config.js?v=ffed3d84';
import { supabaseHeaders } from '../utils.js?v=2668b2f0';

export async function fetchPendingReports(session) {
  const [reportsRes, approvalsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/user_configs?is_flagged=neq.true&select=id,app_id,title,client_id,proton_pulse_user_id,rating,proton_version,cpu,gpu,gpu_driver,gpu_vendor,gpu_architecture,ram,vram_mb,os,kernel,duration,duration_minutes,notes,form_responses,config_key,game_owned,source,created_at,updated_at&order=created_at.desc&limit=200`, {
      headers: supabaseHeaders(session),
    }),
    fetch(`${SUPABASE_URL}/rest/v1/report_approvals?select=report_id,approval_hash`, {
      headers: supabaseHeaders(session),
    }),
  ]);
  if (!reportsRes.ok) throw new Error(`Failed to fetch reports: ${reportsRes.status}`);
  const reports = await reportsRes.json();
  const approvals = approvalsRes.ok ? await approvalsRes.json() : [];
  const approvalMap = new Map(approvals.map(a => [a.report_id, a.approval_hash]));

  return reports
    .filter(r => {
      const storedHash = approvalMap.get(r.id);
      if (!storedHash) return true;
      return storedHash !== computeHash(r);
    })
    .map(r => ({ ...r, _approval_hash: computeHash(r) }));
}

export async function approveReport(session, report) {
  const hash = computeHash(report);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/report_approvals?on_conflict=report_id`, {
    method: 'POST',
    headers: supabaseHeaders(session, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      report_id: report.id,
      approval_hash: hash,
      approved_at: new Date().toISOString(),
      approved_by: 'admin',
    }),
  });
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
}

function computeHash(row) {
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
  const data = new TextEncoder().encode(str);
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
