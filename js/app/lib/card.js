// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=df5b5024';
import { esc } from '../utils.js?v=f53cd830';
import { loadSteamImg as _loadSteamImg } from './steam-img.js?v=e7fe3ce0';

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
  // Both positions are rendered; CSS (driven by data-store-pill-pos on <html>)
  // shows one and hides the other based on the site preference.
  const storeKey = storePill ? esc(String(storePill).toLowerCase()) : '';
  const storeIcon = storeKey === 'steam' || storeKey === 'gog' || storeKey === 'epic'
    ? `<span class="store-icon store-icon--${storeKey}" title="${esc(storePill)}" aria-label="${esc(storePill)}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-store-${storeKey}"/></svg></span>`
    : '';
  // Both the text pill (game-card-store-tag) and the round icon are rendered
  // so CSS can pick which the user prefers via data-store-display on <html>.
  const storeTag = storePill
    ? `<span class="game-card-store-tag game-card-store-pill--${storeKey}"><span class="store-text">${esc(storePill)}</span>${storeIcon}</span>`
    : '';
  const thumbHtml = `<div class="game-card-thumb-wrap">${thumbInner}${storeTag}</div>`;

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
  const storePillHtml = storePill
    ? `<span class="game-card-store-pill game-card-store-pill--${storeKey}"><span class="store-text">${esc(storePill)}</span>${storeIcon}</span>`
    : '';
  const pillsRowHtml = `<div class="game-card-pills">${badgeHtml}${storePillHtml}</div>`;
  const sourceLabelHtml = sourceLabel
    ? `<span class="game-card-source">${esc(sourceLabel)}</span>`
    : '';
  const rightHtml = `<div class="game-card-right">${pillsRowHtml}${sourceLabelHtml}</div>`;
  // Strip layout: a full-width tier-colored bar beneath the title (ProtonDB
  // style). data-tier drives the background via CSS so we do not have to
  // inline color per-card. Hidden by default; data-card-layout="strip" on
  // <html> flips it in for both visibility and the right-column hide.
  const stripTier = tier ? String(tier).toLowerCase() : '';
  const stripLabel = tier ? tier.toUpperCase() : 'NO RATING';
  // Store segment inside the strip. CSS hides it by default and reveals it
  // when data-store-pill-pos is 'bar-right' (chip on the trailing edge) or
  // 'bar-segment' (last 1/4 of the bar in the store color, two-tone with
  // the tier).
  const stripStoreHtml = storePill
    ? `<span class="game-card-strip-store store-icon store-icon--${storeKey}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-store-${storeKey}"/></svg><span class="store-text">${esc(storePill)}</span></span>`
    : '';
  const stripHtml = `<div class="game-card-strip" data-tier="${esc(stripTier)}" data-store="${storeKey}"><span class="game-card-strip-tier">${esc(stripLabel)}</span>${storePillHtml}${stripStoreHtml}</div>`;

  // Card-level corner tag for the 'art-corner' placement. Direct child of
  // <a class="game-card"> so absolute positioning anchors to the card's
  // top-right edge (not just the thumbnail). Hidden by default; shown when
  // data-store-pill-pos="art-corner".
  const cornerTagHtml = storePill
    ? `<span class="game-card-corner-tag game-card-store-pill--${storeKey}"><span class="store-text">${esc(storePill)}</span>${storeIcon}</span>`
    : '';
  // Combined corner chip for the 'combo' card layout. Two-tone pill at the
  // top-right edge of the card with the tier on the left and the store on
  // the right. CSS picks per-tier and per-store colors via data-* attrs.
  // Hidden unless data-card-layout="combo" is set on <html>.
  const comboTier = tier ? String(tier).toLowerCase() : '';
  const comboTierLabel = tier ? tier.toUpperCase() : (badge || 'NO RATING');
  const comboTagHtml = (storePill || tier || badge)
    ? `<span class="game-card-combo-tag" data-tier="${esc(comboTier)}" data-store="${storeKey}"><span class="combo-tier">${esc(comboTierLabel)}</span>${storePill ? `<span class="combo-store">${esc(storePill)}</span>` : ''}</span>`
    : '';
  // Strip is a sibling of the row (not inside the body) so it can extend
  // the full card width including under the thumbnail when strip mode is on.
  return `<a class="game-card" href="${href}">${cornerTagHtml}${comboTagHtml}<div class="game-card-row">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div><div class="game-card-sub">${sub}</div></div>${rightHtml}</div>${stripHtml}</a>`;
}
