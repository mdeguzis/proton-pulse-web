// Unified game card renderer. Single source of truth for the
// thumbnail | title + sub | badge card layout used everywhere.
import { STEAM_IMG } from '../config.js?v=f75c43ba';
import { esc } from '../utils.js?v=d4fea298';

const STEAM_IMG_CDN2 = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

const TIER_COLORS = {
  platinum: { bg: '#b4c7dc', color: '#0a0c10' },
  gold:     { bg: '#c8a050', color: '#111' },
  silver:   { bg: '#8fa0b0', color: '#111' },
  bronze:   { bg: '#b07040', color: '#fff' },
  borked:   { bg: '#c85050', color: '#fff' },
};

// Lazy-loaded map of appId -> headerImageUrl from pipeline-generated game-images.json.
// Covers newer Steam games where the standard /header.jpg path is hashed.
let _gameImagesPromise = null;
function loadGameImages() {
  if (!_gameImagesPromise) {
    _gameImagesPromise = fetch('game-images.json')
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}));
  }
  return _gameImagesPromise;
}

// Called from onerror when both akamai and cloudflare CDN paths fail.
// fb=1 means akamai failed, fb2=1 means cloudflare failed + lookup fired.
window.__steamImgLookup = async (el, appId) => {
  const map = await loadGameImages();
  const url = map[String(appId)];
  if (url) {
    console.log(`[steam-img] appId=${appId} route=game-images-json`);
    el.src = url;
  } else {
    console.warn(`[steam-img] appId=${appId} route=missing all CDN paths exhausted`);
    el.onerror = null;
    el.style.display = 'none';
    el.insertAdjacentHTML('afterend', '<div class="game-card-thumb game-card-thumb--missing">Box art missing</div>');
  }
};

// opts: { href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, chips }
// imgUrl: pre-resolved Steam image URL (bypasses CDN guessing entirely)
// tier: one of platinum/gold/silver/bronze/borked - auto-colours the badge
// badge: raw label string - used when tier is not applicable
// chips: array of pre-built HTML strings rendered below the sub line (source badges etc.)
export function renderGameCard({ href, appId, title, sub, tier, badge, badgeBg, badgeColor, imgUrl, chips }) {
  const primarySrc = imgUrl || (appId ? STEAM_IMG(appId) : '');
  const cdn2Src = appId ? STEAM_IMG_CDN2(appId) : '';
  // appId is always numeric - use bare number to avoid double-quote injection into onerror=""
  const aid = appId != null ? String(appId) : '';
  const thumbHtml = primarySrc
    ? `<img class="game-card-thumb" src="${primarySrc}" alt="" loading="lazy" onerror="if(!this.dataset.fb){this.dataset.fb=1;console.log('[steam-img] appId=${aid} route=cdn2-cloudflare akamai-failed');this.src='${cdn2Src}'}else if(!this.dataset.fb2){this.dataset.fb2=1;window.__steamImgLookup(this,${aid})}else{this.onerror=null;this.style.display='none';this.insertAdjacentHTML('afterend','<div class=\\'game-card-thumb game-card-thumb--missing\\'>Box art missing</div>')}">`
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
  const chipsHtml = chips && chips.length
    ? `<div class="activity-sources">${chips.join('')}</div>`
    : '';

  return `<a class="game-card" href="${href}">${thumbHtml}<div class="game-card-body"><div class="game-card-title">${esc(title)}</div><div class="game-card-sub">${sub}</div>${chipsHtml}</div>${badgeHtml}</a>`;
}
