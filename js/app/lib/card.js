// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=df5b5024';
import { esc } from '../utils.js?v=f5dda5b6';
import { loadSteamImg as _loadSteamImg } from './steam-img.js?v=3e345596';

const TIER_COLORS = {
  platinum: { bg: '#b4c7dc', color: '#0a0c10' },
  gold:     { bg: '#c8a050', color: '#111' },
  silver:   { bg: '#8fa0b0', color: '#111' },
  bronze:   { bg: '#b07040', color: '#fff' },
  borked:   { bg: '#c85050', color: '#fff' },
};

// opts: { href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel, storePill }
// imgUrl: pre-resolved Steam image URL (bypasses CDN guessing entirely)
// tier: one of platinum/gold/silver/bronze/borked - auto-colours the badge
// badge: raw label string - used when tier is not applicable
// storePill: store name shown as a small coloured tag in the bottom-right corner
//   of the artwork (e.g. "Steam", "GOG", "Epic"), keeping the right column free
//   for just the rating pill so titles get more width on mobile.
// sourceLabel: plain muted text shown below the pills (legacy; prefer storePill)
export function renderGameCard({ href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel, storePill }) {
  const primarySrc = imgUrl || (appId ? STEAM_IMG(appId) : '');
  const aid = appId != null ? String(appId) : '';
  const thumbInner = primarySrc
    ? `<img class="game-card-thumb" src="${primarySrc}" data-appid="${aid}" alt="" loading="lazy" onerror="window.__steamImgLoad(this)">`
    : `<div class="game-card-thumb game-card-thumb--missing">Box art missing</div>`;
  // Store tag overlays the artwork corner instead of taking a slot in the right
  // column. Scales with the thumbnail (small on mobile, larger on desktop).
  const storeOverlayHtml = storePill
    ? `<span class="game-card-store-tag game-card-store-pill--${esc(String(storePill).toLowerCase())}">${esc(storePill)}</span>`
    : '';
  const thumbHtml = `<div class="game-card-thumb-wrap">${thumbInner}${storeOverlayHtml}</div>`;

  // Rating pill. A real tier colours the pill; an explicit badge (e.g. "Pulse")
  // is shown as-is; otherwise fall back to a muted "No Rating" pill so every
  // card carries a rating slot, including not-yet-rated catalog games.
  const label = tier ? tier.toUpperCase() : (badge || 'No Rating');
  const isNoRating = !tier && !badge;
  let badgeStyle = '';
  if (tier && TIER_COLORS[tier.toLowerCase()]) {
    const c = TIER_COLORS[tier.toLowerCase()];
    badgeStyle = `style="background:${c.bg};color:${c.color}"`;
  } else if (badgeBg) {
    badgeStyle = `style="background:${badgeBg};color:${badgeColor || '#fff'}"`;
  }
  const badgeHtml = `<span class="game-card-badge${isNoRating ? ' game-card-badge--unrated' : ''}" ${badgeStyle}>${esc(label)}</span>`;
  const pillsRowHtml = `<div class="game-card-pills">${badgeHtml}</div>`;
  const sourceLabelHtml = sourceLabel
    ? `<span class="game-card-source">${esc(sourceLabel)}</span>`
    : '';
  const rightHtml = `<div class="game-card-right">${pillsRowHtml}${sourceLabelHtml}</div>`;

  return `<a class="game-card" href="${href}">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div><div class="game-card-sub">${sub}</div></div>${rightHtml}</a>`;
}
