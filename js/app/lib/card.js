// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=f75c43ba';
import { esc } from '../utils.js?v=d4fea298';

const FALLBACK_IMG = 'https://cdn.cloudflare.steamstatic.com/steam/apps/70/capsule_231x87.jpg';
const STEAM_IMG_CDN2 = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

const TIER_COLORS = {
  platinum: { bg: '#b4c7dc', color: '#0a0c10' },
  gold:     { bg: '#c8a050', color: '#111' },
  silver:   { bg: '#8fa0b0', color: '#111' },
  bronze:   { bg: '#b07040', color: '#fff' },
  borked:   { bg: '#c85050', color: '#fff' },
};

// opts: { href, appId, title, sub, tier, badge, badgeBg, badgeColor }
// tier: one of platinum/gold/silver/bronze/borked - auto-colours the badge
// badge: raw label string - used when tier is not applicable
export function renderGameCard({ href, appId, title, sub, tier, badge, badgeBg, badgeColor }) {
  const img = appId ? STEAM_IMG(appId) : '';
  const thumbHtml = img
    ? `<img class="game-card-thumb" src="${img}" alt="" loading="lazy" onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${STEAM_IMG_CDN2(appId)}'}else{this.onerror=null;this.src='${FALLBACK_IMG}'}">`
    : `<div class="game-card-thumb"></div>`;

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

  return `<a class="game-card" href="${href}">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div><div class="game-card-sub">${sub}</div></div>${badgeHtml}</a>`;
}
