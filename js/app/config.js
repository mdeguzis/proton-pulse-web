// Environment constants and app-wide config.
// Copied verbatim from app.js lines 1-39; do not paraphrase or "improve" them.

export const SB_URL = 'https://ilsgdshkaocrmibwdezk.supabase.co/rest/v1';
export const SB_KEY = 'sb_publishable_3Oqhm4JneafJNQw9BuUaxw_L9qZa-5V';
export const STEAM_IMG = id => `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
// On github.io project page the URL is /proton-pulse-data/..., on the custom
// domain (www.proton-pulse.com) it serves from root. Keep SITE_BASE empty on
// the custom domain so links don't get a bogus prefix.
export const SITE_BASE = (() => {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'proton-pulse-data' ? '/proton-pulse-data' : '';
})();
// On localhost the local /data directory is gitignored + empty (real data
// comes from the pipeline running in CI). Fetch from the production CDN
// instead so any searched game works during local dev preview.
export const IS_LOCAL_DEV = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
export const CDN = IS_LOCAL_DEV
  ? 'https://www.proton-pulse.com/data'
  : `${window.location.origin}${SITE_BASE}/data`;
// Data Files link points at the same place we fetch data from - so localhost
// users browse the prod data directory rather than 404'ing on a missing
// local one
export const dataFilesHref = appId => IS_LOCAL_DEV
  ? `https://www.proton-pulse.com/data/${appId}/`
  : `${SITE_BASE}/data/${appId}/`;
// Steam app IDs are sequentially assigned and currently top out ~3 million.
// Non-Steam shortcut IDs are CRC32-derived and can be any 32-bit value.
// Any ID above 10 million is treated as a non-Steam shortcut.
export const isNonSteamAppId = id => Number(id) > 10_000_000;

export const RATING_COLORS = {
  platinum: '#b4c7dc', gold: '#c8a050', silver: '#8fa0b0',
  bronze: '#b07040', borked: '#c85050', pending: '#3a4a5a'
};
export const RATING_TEXT = {
  platinum: '#0a0c10', gold: '#0a0c10', silver: '#0a0c10',
  bronze: '#0a0c10', borked: '#fff', pending: '#c8d4e0'
};

// ---------------------------------------------------------------------------
// TEMPORARY Phase-A bridge: re-export symbols defined in the classic-script
// siblings (app-scoring.js, app-submit.js) that app.js calls as bare globals.
// These window.X assignments exist because those siblings are loaded as plain
// <script> tags before the ES module entry point, so the functions land on
// window. Remove this entire block in Phase B when those files are converted
// to ES modules and can be imported directly.
// ---------------------------------------------------------------------------
export const estimateScore           = window.estimateScore;
export const getWebClientId          = window.getWebClientId;
export const populateScoringTooltip  = window.populateScoringTooltip;
export const pulseTierFromReports    = window.pulseTierFromReports;
export const tierFromReports         = window.tierFromReports;
