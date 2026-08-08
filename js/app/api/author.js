// author (api) for the app page. Relocated from app.js.

export function getAuthorIdentity(r) {
  const src = (r.source || '').toLowerCase();
  if (src === 'protondb') {
    return {
      kind: 'protondb',
      displayName: 'ProtonDB user',
      subtitle: r.reportId != null ? `#${r.reportId}` : 'anonymous',
    };
  }
  const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
  const cid = r.clientId || r.client_id || '';
  const idShort = (ppId || cid).slice(0, 8);
  const label = src.startsWith('web') ? 'Web user' : 'Plugin user';
  return {
    kind: 'pulse',
    displayName: label,
    subtitle: idShort ? `#${idShort}…` : 'anonymous',
  };
}

// in-memory cache for author stats + avatars so we don't re-fetch per card
export const _authorCache = {};

// fetch author aggregate stats from Supabase RPC
export async function fetchAuthorStats(r) {
  const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
  const cid = r.clientId || r.client_id || '';
  const key = ppId || cid;
  if (!key || _authorCache[key]?.stats) return _authorCache[key]?.stats || null;

  try {
    const rpcName = ppId ? 'author_stats_by_user' : 'author_stats_by_client';
    const param = ppId ? { p_user_id: ppId } : { p_client_id: cid };
    const url = `${SUPABASE_URL}/rest/v1/rpc/${rpcName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(param),
    });
    if (!resp.ok) return null;
    const stats = await resp.json();
    _authorCache[key] = _authorCache[key] || {};
    _authorCache[key].stats = stats;
    return stats;
  } catch { return null; }
}

// fetch cached avatar for a linked Pulse user
export async function fetchAuthorAvatar(ppId) {
  if (!ppId || _authorCache[ppId]?.avatar !== undefined) return _authorCache[ppId]?.avatar || null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/author_avatars?proton_pulse_user_id=eq.${ppId}&select=avatar_url,display_name,cached_at`;
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    const row = rows[0] || null;
    _authorCache[ppId] = _authorCache[ppId] || {};
    _authorCache[ppId].avatar = row;
    return row;
  } catch { return null; }
}

// render the author block, then async-enhance with stats + avatar
