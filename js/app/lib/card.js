// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=9970759a';
import { esc } from '../utils.js?v=5184cce6';
import { loadSteamImg as _loadSteamImg } from './steam-img.js?v=85cf4195';

const TIER_COLORS = {
  platinum: { bg: '#b4c7dc', color: '#0a0c10' },
  gold:     { bg: '#c8a050', color: '#111' },
  silver:   { bg: '#8fa0b0', color: '#111' },
  bronze:   { bg: '#b07040', color: '#fff' },
  borked:   { bg: '#c85050', color: '#fff' },
};

// opts: { href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel }
// imgUrl: pre-resolved Steam image URL (bypasses CDN guessing entirely)
// tier: one of platinum/gold/silver/bronze/borked - auto-colours the badge
// badge: raw label string - used when tier is not applicable
// sourceLabel: plain text shown below the badge pill (e.g. "Steam", "Non-Steam")
export function renderGameCard({ href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel }) {
  const primarySrc = imgUrl || (appId ? STEAM_IMG(appId) : '');
  const aid = appId != null ? String(appId) : '';
  const thumbHtml = primarySrc
    ? `<img class="game-card-thumb" src="${primarySrc}" data-appid="${aid}" alt="" loading="lazy" onerror="window.__steamImgLoad(this)">`
    : `<div class="game-card-thumb game-card-thumb--missing">Box art missing</div>`;

  const label = tier ? tier.toUpperCase() : (badge || '');
  let badgeStyle = '';
  if (tier && TIER_COLORS[tier.toLowerCase()]) {
    const c = TIER_COLORS[tier.toLowerCase()];
    badgeStyle = `style="background:${c.bg};color:${c.color}"`;
  } else if (badgeBg) {
    badgeStyle = `style="background:${badgeBg};color:${badgeColor || '#fff'}"`;
  }
  const badgeHtml = label
    ? `<span class="game-card-badge" ${badgeStyle}>${esc(label)}</span>`
    : '';
  const sourceLabelHtml = sourceLabel
    ? `<span class="game-card-source">${esc(sourceLabel)}</span>`
    : '';
  const rightHtml = (badgeHtml || sourceLabelHtml)
    ? `<div class="game-card-right">${badgeHtml}${sourceLabelHtml}</div>`
    : '';

  return `<a class="game-card" href="${href}">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div><div class="game-card-sub">${sub}</div></div>${rightHtml}</a>`;
}
