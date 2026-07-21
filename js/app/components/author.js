// author (components) for the app page. Relocated from app.js.

import { fetchAuthorAvatar, fetchAuthorStats, getAuthorIdentity } from '../api/author.js?v=0d33fd7b';
import { CDN } from '../config.js?v=979b9bbc';
import { route } from '../router.js?v=e6357594';
import { esc } from '../utils.js?v=9a39c726';

export const ATOM_ICON_SVG = `
  <svg viewBox="0 0 36 36" fill="none" aria-hidden="true">
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(60 18 18)"/>
    <ellipse cx="18" cy="18" rx="15" ry="5.5" stroke="currentColor" stroke-width="1.4" transform="rotate(-60 18 18)"/>
    <circle cx="18" cy="18" r="2.8" fill="currentColor"/>
  </svg>`;

// Hardware fingerprints for Steam Deck detection - same regexes the pipeline
// stats.py uses. VanGogh = LCD APU codename; Sephiroth / APU 0932 = OLED.

export function renderAuthorBlock(r) {
  const a = getAuthorIdentity(r);
  const fullId = r.protonPulseUserId || r.proton_pulse_user_id || r.clientId || r.client_id || '';
  const tooltipExtra = fullId ? `\nFull id: ${fullId}` : '';
  // data-author-key lets the async enhancer find this element
  const authorKey = fullId.slice(0, 16);
  const verifiedOwner = r.ownerVerified === true || r.owner_verified === true;
  const verifiedBadge = verifiedOwner
    ? `<div class="author-verified" title="Verified owner: reporter's Steam library confirms they own this game"><svg viewBox="0 0 16 16" width="11" height="11" fill="#2ea043" aria-hidden="true"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.7 6.3l-4.5 4.5a.75.75 0 01-1.06 0L4.3 8.94a.75.75 0 111.06-1.06l1.31 1.31 3.97-3.97a.75.75 0 111.06 1.06z"/></svg><span>Verified owner</span></div>`
    : '';
  return `
    <div class="card-author" data-author-key="${esc(authorKey)}" title="${esc(a.displayName)} ${esc(a.subtitle)}${esc(tooltipExtra)}">
      <div class="author-avatar author-avatar-${a.kind}">${ATOM_ICON_SVG}</div>
      <div class="author-name">${esc(a.displayName)}</div>
      <div class="author-sub" title="${esc(fullId || a.subtitle)}">${esc(a.subtitle)}</div>
      ${verifiedBadge}
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
