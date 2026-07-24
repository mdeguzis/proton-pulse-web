// Environment constants and app-wide config.
// Copied verbatim from app.js lines 1-39; do not paraphrase or "improve" them.

export const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
export const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
export const STEAM_IMG = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
// On github.io project page the URL is /proton-pulse-web/..., on the custom
// domain (www.proton-pulse.com) it serves from root. Keep SITE_BASE empty on
// the custom domain so links don't get a bogus prefix.
export const SITE_BASE = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'proton-pulse-web' ? '/proton-pulse-web' : '';
})();
// On localhost the local /data directory is gitignored + empty (real data
// comes from the pipeline running in CI). Fetch from the production CDN
// instead so any searched game works during local dev preview.
export const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
// Staging is served at <host>/proton-pulse-web-staging/... on GitHub Pages.
// Detecting it by path lets us keep IS_LOCAL_DEV separate and lets staging
// fetch its own data instead of falling through to prod like it used to.
// See #117 -- previous behaviour (USES_PROD_DATA=true on any .github.io)
// meant pipeline-data changes could not be smoke-tested on staging at all.
export const IS_STAGING = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'proton-pulse-web-staging';
})();
// Fix SITE_BASE for staging so its own resources resolve to
// /proton-pulse-web-staging/... instead of an empty (=root) prefix.
export const STAGING_SITE_BASE = IS_STAGING ? '/proton-pulse-web-staging' : SITE_BASE;
// Only fall through to prod data on true local dev now. Staging + the real
// domain both read from their own origin. If a staging pipeline run hasn't
// populated a given file yet, the client falls back to prod at fetch time
// via withProdFallback() below -- see #117.
export const USES_PROD_DATA = IS_LOCAL_DEV;
export const SITE_ROOT = USES_PROD_DATA
  ? 'https://www.proton-pulse.com'
  : `${window.location.origin}${STAGING_SITE_BASE}`;
export const PROD_ROOT = 'https://www.proton-pulse.com';
export const CDN = USES_PROD_DATA
  ? 'https://www.proton-pulse.com/data'
  : `${window.location.origin}${STAGING_SITE_BASE}/data`;
export const dataFilesHref = appId => USES_PROD_DATA
  ? `https://www.proton-pulse.com/data/${appId}/`
  : `${STAGING_SITE_BASE}/data/${appId}/`;

// Fetch a pipeline data path from the current origin first; if it 404s,
// retry once against production so a staging build that hasn't run the
// full pipeline yet still gets working data. Local dev keeps its
// existing behaviour (goes straight to prod via USES_PROD_DATA).
export async function fetchDataWithProdFallback(bustedName) {
  if (USES_PROD_DATA) return fetch(`${SITE_ROOT}/${bustedName}`);
  const localUrl = `${SITE_ROOT}/${bustedName}`;
  try {
    const r = await fetch(localUrl);
    if (r.ok) return r;
    if (r.status === 404 && !IS_LOCAL_DEV) return fetch(`${PROD_ROOT}/${bustedName}`);
    return r;
  } catch (e) {
    if (!IS_LOCAL_DEV) return fetch(`${PROD_ROOT}/${bustedName}`);
    throw e;
  }
}
// Steam app IDs are sequentially assigned and currently top out ~3 million.
// Non-Steam shortcut IDs are CRC32-derived and can be any 32-bit value.
// Any ID above 10 million is treated as a non-Steam shortcut.
export const isNonSteamAppId = id => Number(id) > 10_000_000;

// Catalog (non-Steam) games carry a prefixed canonical id: gog:<productId>
// or epic:<namespace>. Steam ids are bare digits. Keep this in lockstep with
// the pipeline helper app_type_from_id in scripts/pipeline/common.py.
export const appTypeFromAppId = id => {
  const s = String(id);
  if (s.startsWith('gog:')) return 'gog';
  if (s.startsWith('epic:')) return 'epic';
  return 'steam';
};
// Human-readable store label for the row source line on cards.
export const STORE_LABELS = { gog: 'GOG', epic: 'Epic', steam: 'Steam' };
export const storeLabel = appType => STORE_LABELS[appType] || 'Steam';
// Label resolved straight from a canonical app id, for callers that only have
// the id (search index stubs, cards built from a bare id).
export const storeLabelFromAppId = id => storeLabel(appTypeFromAppId(id));

export const RATING_COLORS = {
  platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0',
  bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a'
};
export const RATING_TEXT = {
  platinum: '#0a0c10', gold: '#0a0c10', silver: '#0a0c10',
  bronze: '#0a0c10', borked: '#fff', pending: '#c8d4e0'
};
