// author module for the app page. Relocated from app.js.

import { CDN } from './config.js';
import { route } from './router.js';
import { esc } from './utils.js';

export const ATOM_ICON_SVG = `
  <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(60 18 18)"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(-60 18 18)"/>
    <circle cx="18" cy="18" r="2.8" fill="currentColor"/>
  </svg>`;

// Hardware fingerprints for Steam Deck detection - same regexes the pipeline
// stats.py uses. VanGogh = LCD APU codename; Sephiroth / APU 0932 = OLED.

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
export function renderAuthorBlock(r) {
  const a = getAuthorIdentity(r);
  const fullId = r.protonPulseUserId || r.proton_pulse_user_id || r.clientId || r.client_id || '';
  const tooltipExtra = fullId ? `\nFull id: ${fullId}` : '';
  // data-author-key lets the async enhancer find this element
  const authorKey = fullId.slice(0, 16);
  return `
    <div class="card-author" data-author-key="${esc(authorKey)}" title="${esc(a.displayName)} ${esc(a.subtitle)}${esc(tooltipExtra)}">
      <div class="author-avatar author-avatar-${a.kind}">${ATOM_ICON_SVG}</div>
      <div class="author-name">${esc(a.displayName)}</div>
      <div class="author-sub" title="${esc(fullId || a.subtitle)}">${esc(a.subtitle)}</div>
      <div class="author-stats"></div>
    </div>`;
}

// call after cards are in the DOM to backfill stats + avatars
export async function enhanceAuthorBlocks(reports) {
  // dedupe: one fetch per unique author, not per card
  const seen = new Set();
  for (const r of reports) {
    const src = (r.source || '').toLowerCase();
    if (src === 'protondb') continue; // cant aggregate anonymous CDN reports
    const ppId = r.protonPulseUserId || r.proton_pulse_user_id;
    const cid = r.clientId || r.client_id || '';
    const key = (ppId || cid).slice(0, 16);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // fire stats + avatar fetches in parallel
    const [stats, avatar] = await Promise.all([
      fetchAuthorStats(r),
      ppId ? fetchAuthorAvatar(ppId) : Promise.resolve(null),
    ]);

    // patch matching DOM elements
    const els = document.querySelectorAll(`[data-author-key="${key}"]`);
    for (const el of els) {
      if (stats && stats.report_count > 0) {
        const statsEl = el.querySelector('.author-stats');
        if (statsEl) {
          const hrs = stats.total_hours > 0 ? ` / ${stats.total_hours}h` : '';
          statsEl.textContent = `${stats.report_count} reports${hrs}`;
        }
      }
      if (avatar?.avatar_url) {
        const avatarEl = el.querySelector('.author-avatar');
        if (avatarEl) {
          avatarEl.innerHTML = `<img src="${esc(avatar.avatar_url)}" alt="" class="author-avatar-img">`;
        }
        // use Steam display name if available
        if (avatar.display_name) {
          const nameEl = el.querySelector('.author-name');
          if (nameEl) nameEl.textContent = avatar.display_name;
        }
      }
    }
  }
}

// Permalink button - copies a deep-link to the clipboard. Hash format mirrors
// the existing route shape: #/app/{appId}#report-{id}
// ProtonDB reports don't carry reportId or clientId (they're imported), so
// fall back to a short hash of timestamp+gpu+proton so every report gets a
// stable shareable link. djb2 hash trimmed to 7 hex chars is enough collision
// resistance for per-game uniqueness
