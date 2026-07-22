// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=979b9bbc';
import { esc } from '../utils.js?v=9a39c726';
import { loadSteamImg as _loadSteamImg } from './steam-img.js?v=2f0dee0e';

const TIER_COLORS = {
  platinum: { bg: '#b4c7dc', color: '#0a0c10' },
  gold:     { bg: '#c8a050', color: '#111' },
  silver:   { bg: '#8fa0b0', color: '#111' },
  bronze:   { bg: '#b07040', color: '#fff' },
  borked:   { bg: '#c85050', color: '#fff' },
};

// opts: { href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel, storePill, trend, replacedBy, steamType, ownerBadges }
// ownerBadges: pre-rendered HTML (usually two <span class="game-card-owner-badge">
//   elements) that clip onto the left side of the store corner tag on the
//   thumbnail. Currently: "In library" (open book) + "On wishlist" (list + heart).
//   Opt-in via Site Options; caller passes empty string when the pref is off
//   or the user isn't signed in.
// imgUrl: pre-resolved Steam image URL (bypasses CDN guessing entirely)
// tier: one of platinum/gold/silver/bronze/borked - auto-colours the badge
// badge: raw label string - used when tier is not applicable
// storePill: store name shown as a small coloured tag in the bottom-right corner
//   of the artwork (e.g. "Steam", "GOG", "Epic"), keeping the right column free
//   for just the rating pill so titles get more width on mobile.
// sourceLabel: plain muted text shown below the pills (legacy; prefer storePill)
// trend: compatibility trend direction from the pipeline (recent 90d vs 90-270d
//   playable-share). Renders a small up/down arrow next to the tier + store
//   pills. 'improving' -> green up, 'declining' -> red down. Any other value
//   (stable, insufficient, undefined, "") renders nothing so unchanged games
//   read as neutral without adding a "stable" glyph to every card.
// steamType: Steam appdetails type field (dlc/mod/demo/software/video/...).
//   Anything other than "game" renders a small corner tag on the thumbnail so
//   users scanning a library grid can pick out the DLC bundles and mods at a
//   glance. Empty / "game" render no tag.
export function renderGameCard({ href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, sourceLabel, storePill, trend, replacedBy, steamType, ownerBadges }) {
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
  // Owner badges attach to the LEFT of whichever store-badge variant is
  // active, so the whole strip reads as one extended pill in the user's
  // configured position (art / art-corner / right / bar-*). Prepended
  // inside each variant so CSS visibility rules don't need to know about
  // them separately.
  const ownerBadgesHtml = ownerBadges || '';
  // Both the text pill (game-card-store-tag) and the round icon are rendered
  // so CSS can pick which the user prefers via data-store-display on <html>.
  const storeTag = storePill
    ? `<span class="game-card-store-tag game-card-store-pill--${storeKey}">${ownerBadgesHtml}<span class="store-text">${esc(storePill)}</span>${storeIcon}</span>`
    : '';
  // Steam-side appid replacement (e.g. 5488 -> 45700). Small tag over the
  // thumbnail so browse lists visually mark the old entry.
  const replacedTag = replacedBy
    ? `<span class="game-card-replaced-tag" title="Replaced by app ${esc(String(replacedBy))}: new reports should target that appid">REPLACED</span>`
    : '';
  // App type markers (mod / dlc / demo / software) no longer overlay the tile
  // (#251 follow-up): Steam's own box art already reads as a mod / DLC, and the
  // corner ribbon looked noisy. The type is shown under the artwork on the game
  // detail page instead (see game-page.js #game-type-strip). steamType is kept
  // in the signature so callers don't need to change.
  const thumbHtml = `<div class="game-card-thumb-wrap">${thumbInner}${storeTag}${replacedTag}</div>`;

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
  // Trend arrow. Only 'improving' and 'declining' render; stable and
  // insufficient are absent by design so a card stays quiet when nothing has
  // changed. aria-label carries the plain-English direction for AT users.
  const trendKey = trend === 'improving' || trend === 'declining' ? trend : '';
  const trendGlyph = trendKey === 'improving'
    ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2 L10 8 L2 8 Z" fill="currentColor"/></svg>'
    : trendKey === 'declining'
      ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10 L10 4 L2 4 Z" fill="currentColor"/></svg>'
      : '';
  const trendLabel = trendKey === 'improving'
    ? 'Compatibility trending up'
    : trendKey === 'declining'
      ? 'Compatibility trending down'
      : '';
  const trendHtml = trendKey
    ? `<span class="game-card-trend game-card-trend--${trendKey}" title="${trendLabel}" aria-label="${trendLabel}">${trendGlyph}</span>`
    : '';
  const pillsRowHtml = `<div class="game-card-pills">${badgeHtml}${storePillHtml}${trendHtml}</div>`;
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
    ? `<span class="game-card-corner-tag game-card-store-pill--${storeKey}">${ownerBadgesHtml}<span class="store-text">${esc(storePill)}</span>${storeIcon}</span>`
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
  // The report-count "sub" line is only rendered when the caller supplies
  // one. Home browse cards deliberately pass an empty sub since the report
  // count + latest date and any user-context tags all live on the game
  // details page under the artwork instead (#266).
  const subHtml = sub ? `<div class="game-card-sub">${sub}</div>` : '';
  return `<a class="game-card" href="${href}">${cornerTagHtml}${comboTagHtml}<div class="game-card-row">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div>${subHtml}</div>${rightHtml}</div>${stripHtml}</a>`;
}
