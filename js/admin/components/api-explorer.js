// Admin API Explorer tab (issue #186).
//
// Inspect the raw JSON the stores return for a game -- handy for debugging box
// art, content descriptors, Steam Deck verdicts, and GOG / Epic catalog data.
// Store tabs switch between Steam / GOG / Epic; each has its own endpoints.
// Steam & GOG accept an app/product ID or a name (resolved against the search
// index); GOG catalog search and Epic search take a free-text term. The fetch
// goes through the steam-explore edge function because the stores are
// CORS-blocked from the browser.

import { dataUrl } from '../../lib/data-url.js?v=97f09986';
import { escapeHtml } from '../utils.js?v=2668b2f0';
import { exploreStore } from '../api/steam-explore.js?v=17281b89';
import { isLibraryEndpoint, lookupLibrary } from '../api/steam-library-lookup.js?v=748599e3';
import { exploreCargoPCGamingWiki } from '../api/pcgamingwiki-explore.js?v=49d016c5';

// Store -> endpoints. `arg` is 'id' (numeric app/product id, name-resolvable)
// or 'term' (free-text search). Keys match the edge function's ENDPOINTS.
const STORES = {
  steam: {
    label: 'Steam',
    placeholder: 'App ID or game name',
    endpoints: [
      { key: 'steam_appdetails', label: 'appdetails (metadata + content descriptors)', arg: 'id' },
      { key: 'steam_deck', label: 'Deck / Machine / SteamOS compatibility', arg: 'id' },
      { key: 'steam_store_redirect', label: 'store page redirect (detect replaced_by)', arg: 'id' },
      { key: 'steam_current_players', label: 'current online players', arg: 'id' },
      { key: 'steam_global_achievements', label: 'global achievement percentages', arg: 'id' },
      { key: 'steam_news', label: 'news for app (latest 5 posts)', arg: 'id' },
      { key: 'steam_reviews', label: 'user review summary', arg: 'id' },
      { key: 'steam_community_search', label: 'community search (autocomplete)', arg: 'term' },
      { key: 'steam_featured', label: 'store featured (front page)', arg: 'none' },
      { key: 'steam_featured_categories', label: 'store featured categories', arg: 'none' },
      // Keyed Steam Web API endpoints. Filtered out for non-admin users
      // in populateEndpoints below; the edge fn also verifies manage_admins
      // so the key never leaves the server for a non-admin caller. #221.
      { key: 'steam_get_owned_games',     label: 'GetOwnedGames -- library for steamid (admin)',           arg: 'steamid', adminGated: true },
      { key: 'steam_get_recently_played', label: 'GetRecentlyPlayedGames -- recent for steamid (admin)',   arg: 'steamid', adminGated: true },
      { key: 'steam_resolve_vanity',      label: 'ResolveVanityURL -- vanity name -> steamid (admin)',     arg: 'vanity',  adminGated: true },
    ],
  },
  gog: {
    label: 'GOG',
    placeholder: 'GOG product ID, game name, or search term',
    endpoints: [
      { key: 'gog_product', label: 'product details (by ID / name)', arg: 'id' },
      { key: 'gog_search', label: 'catalog search (by term)', arg: 'term' },
    ],
  },
  epic: {
    label: 'Epic',
    placeholder: 'Game name / search term',
    endpoints: [
      { key: 'epic_search', label: 'store search (by term)', arg: 'term' },
    ],
  },
  // ProtonDB tab (#280). Public data endpoints for debugging tier /
  // confidence / total per app, and the global counts sanity check.
  // Routed through the same steam-explore edge fn as the store endpoints.
  protondb: {
    label: 'ProtonDB',
    placeholder: 'Steam App ID or game name',
    endpoints: [
      { key: 'protondb_summary', label: 'summary (tier + confidence + best/worst per app)', arg: 'id' },
      { key: 'protondb_counts', label: 'global counts (sanity check)', arg: 'none' },
    ],
  },
  // PCGamingWiki tab (#377). Client-side Cargo API fetch -- PGWiki is
  // CORS-enabled + public. Lets admins inspect what the pipeline enricher
  // will see for any given game before shipping data-driven UI on it.
  pcgamingwiki: {
    label: 'PCGamingWiki',
    placeholder: 'Steam App ID, game title, or Cargo table name',
    endpoints: [
      { key: 'pcgw_by_appid', label: 'Infobox_game by Steam App ID (Cargo HOLDS query)', arg: 'id' },
      { key: 'pcgw_by_title', label: 'Infobox_game by title substring (Cargo LIKE)', arg: 'term', placeholder: 'Title fragment (e.g. half-life)' },
      { key: 'pcgw_table_fields', label: 'cargofields -- schema of a Cargo table (default: Infobox_game)', arg: 'term', placeholder: 'Cargo table name (leave empty for Infobox_game)' },
    ],
  },
};

// Reference docs per endpoint, shown in the Field descriptions popup. Keep in
// sync with the pipeline + the web wiki.
const FIELD_DOCS = {
  steam_appdetails: {
    title: 'Steam appdetails',
    rows: [
      ['content_descriptors.ids', 'Developer-set content flags. We treat 3 and 4 as adult and hide those by default. 1 = Some Nudity or Sexual Content (NOT filtered -- too broad, catches BG3 / Cyberpunk). 2 = Frequent Violence or Gore (not filtered). 3 = Adult Only Sexual Content (adult). 4 = Frequent Nudity or Sexual Content (adult). 5 = General Mature Content (not filtered).'],
      ['content_descriptors.notes', 'Free-text summary of the descriptors.'],
      ['required_age', 'Age gate on the store page. Often 0 even for adult games (Steam uses content_descriptors instead), so we do NOT use it for the adult flag.'],
      ['type', 'game / dlc / demo / music / ...'],
      ['header_image', 'The 460x215 box-art URL.'],
      ['success', 'false = app removed, region-locked, or the fetch was rate-limited.'],
    ],
  },
  steam_deck: {
    title: 'Steam Deck compatibility',
    rows: [
      ['resolved_category', "Valve's overall Deck verdict. 0 = Unknown, 1 = Unsupported, 2 = Playable, 3 = Verified."],
      ['steamos_resolved_category', 'Proton / OS-layer status, tracked separately. Often 2 even when overall Verified.'],
      ['resolved_items[].display_type', '0 = Neutral/info. 1 = Incompatible/blocked (red x). 2 = Minor issue (yellow !). 3 = System pass (internal). 4 = Full pass (green check).'],
      ['resolved_items[].loc_token', 'Criterion identifier, e.g. #SteamDeckVerified_TestResult_InterfaceTextIsLegible.'],
    ],
  },
  steam_store_redirect: {
    title: 'Steam store page redirect (replaced_by detection)',
    rows: [
      ['original_appid', 'The appid we asked about.'],
      ['original_url', 'store.steampowered.com/app/<originalAppid>/'],
      ['hops[]', 'Every request-response pair the edge function made, curl -L -v style: { step, method, url, status, status_text, location, content_type }. The green-bordered block above the JSON renders this as a trace.'],
      ['final_url', 'The URL of the last hop.'],
      ['final_status / final_content_type', 'HTTP status + Content-Type of the last hop.'],
      ['final_appid', 'Appid parsed from the final URL, or null if it did not land on /app/<n>/.'],
      ['replaced_by', 'The new appid if it differs from the original -- Steam has superseded the entry. null when the store page resolved back to the same appid (live game) or to a non-app URL.'],
      ['note', 'Human-readable summary of what happened.'],
    ],
  },
  steam_current_players: {
    title: 'Current online players (ISteamUserStats/GetNumberOfCurrentPlayers)',
    rows: [
      ['response.player_count', 'Live count of concurrent players. Free games and delisted apps return 1 (Valve) or the endpoint 404s.'],
      ['response.result', '1 = success. Anything else means the appid is invalid or the endpoint refused it.'],
    ],
  },
  steam_global_achievements: {
    title: 'Global achievement percentages (ISteamUserStats/GetGlobalAchievementPercentagesForApp)',
    rows: [
      ['achievementpercentages.achievements[].name', 'Internal achievement key. Cross-reference with the store page to see the human-readable name.'],
      ['achievementpercentages.achievements[].percent', 'What fraction of players who own the app have unlocked this achievement. Useful for spotting which achievements are unusually rare or common.'],
    ],
  },
  steam_news: {
    title: 'News for app (ISteamNews/GetNewsForApp)',
    rows: [
      ['appnews.newsitems[].title', 'Post title. Feed includes both official Valve posts and community items.'],
      ['appnews.newsitems[].contents', 'Body preview (truncated to 300 chars by our call).'],
      ['appnews.newsitems[].date', 'Unix timestamp of the post.'],
      ['appnews.newsitems[].feedlabel', "Feed name -- e.g. 'Community Announcements', 'Steam Community Announcements'."],
    ],
  },
  steam_reviews: {
    title: 'User review summary (store.steampowered.com/appreviews)',
    rows: [
      ['query_summary.review_score', 'Steam review-tier score (0-9). Maps to Overwhelmingly Positive down to Overwhelmingly Negative.'],
      ['query_summary.review_score_desc', 'Human-readable label, e.g. "Very Positive".'],
      ['query_summary.total_reviews', 'All-time review count.'],
      ['query_summary.total_positive / total_negative', 'Split of positive vs negative reviews.'],
    ],
  },
  steam_community_search: {
    title: 'Community search (steamcommunity.com/actions/SearchApps)',
    rows: [
      ['[].appid', 'Numeric appid.'],
      ['[].name', 'Store title. Useful for confirming a title spelling before feeding it back into other calls.'],
      ['[].icon', 'Small icon URL. Steam only returns entries with an actual store page here, so it filters out most fully-delisted games.'],
    ],
  },
  steam_featured: {
    title: 'Store featured (store.steampowered.com/api/featured)',
    rows: [
      ['featured_win / featured_mac / featured_linux', 'Per-OS featured banners currently on the storefront.'],
      ['status', "1 = ok. If Steam's storefront is down this endpoint 500s and our proxy still passes the status through."],
    ],
  },
  steam_featured_categories: {
    title: 'Store featured categories (store.steampowered.com/api/featuredcategories)',
    rows: [
      ['specials.items[].id', "Appid within a special/sale category. Cross-reference with appdetails to see if it's genuinely on sale."],
      ['new_releases / top_sellers / coming_soon', 'Category blocks with their own items[] arrays.'],
    ],
  },
  gog_product: {
    title: 'GOG product (api.gog.com/products/<id>)',
    rows: [
      ['id', 'Numeric GOG product id (our index stores it as gog:<id>).'],
      ['title', 'Game title.'],
      ['images.logo / .background', 'Cover / background art URLs (protocol-relative).'],
      ['links.product_card / .purchase_link', 'Store page and purchase URLs.'],
      ['content_system_compatibility', 'OS availability (windows / osx / linux booleans).'],
      ['is_secret / in_development', 'Visibility / release-state flags.'],
    ],
  },
  gog_search: {
    title: 'GOG catalog search (catalog.gog.com/v1/catalog)',
    rows: [
      ['products[]', 'Matching catalog entries.'],
      ['products[].id / .title / .slug', 'Product id, title, and URL slug.'],
      ['products[].coverHorizontal / .coverVertical', 'Cover art URLs.'],
      ['products[].price', 'Pricing (final / base / discount).'],
      ['productCount / pages', 'Total matches and pagination.'],
    ],
  },
  epic_search: {
    title: 'Epic store search (GraphQL searchStore)',
    rows: [
      ['data.Catalog.searchStore.elements[]', 'Matching store offers.'],
      ['elements[].title / .namespace / .productSlug', 'Title, catalog namespace, and store slug (our index stores epic:<namespace>).'],
      ['elements[].keyImages[]', 'Art assets by type (DieselStoreFrontWide, OfferImageWide, ...).'],
      ['elements[].offerType', 'BASE_GAME / DLC / ADD_ON / ...'],
      ['elements[].price.totalPrice', 'discountPrice / originalPrice (in cents).'],
    ],
  },
  steam_get_owned_games: {
    title: 'Owned games (IPlayerService/GetOwnedGames)',
    rows: [
      ['response.game_count', 'Total games on the account (including F2P titles the user has launched).'],
      ['response.games[].appid', 'Numeric Steam app ID -- cross-reference with the search index.'],
      ['response.games[].name', 'Store title (present because we sent include_appinfo=1).'],
      ['response.games[].playtime_forever', 'Lifetime playtime in minutes across all sessions.'],
      ['response.games[].playtime_2weeks', 'Recent (last 2 weeks) playtime in minutes. Absent if the user has not played it recently.'],
      ['response.games[].img_icon_url', 'Icon hash. Combine as https://media.steampowered.com/steamcommunity/public/images/apps/<appid>/<hash>.jpg.'],
      ['response.games[].rtime_last_played', 'Unix timestamp of the most recent session for that title.'],
    ],
  },
  steam_get_recently_played: {
    title: 'Recently played (IPlayerService/GetRecentlyPlayedGames)',
    rows: [
      ['response.total_count', 'Number of games played in the last two weeks. Steam caps the list at 10-20 apps.'],
      ['response.games[]', 'One entry per recently-played app.'],
      ['response.games[].appid / .name / .img_icon_url', 'Same fields as GetOwnedGames -- resolve the icon URL the same way.'],
      ['response.games[].playtime_forever', 'Lifetime playtime in minutes (mirror of GetOwnedGames).'],
      ['response.games[].playtime_2weeks', 'Minutes played in the current 2-week window. Drives the "recent" ordering.'],
    ],
  },
  steam_resolve_vanity: {
    title: 'Resolve vanity URL (ISteamUser/ResolveVanityURL)',
    rows: [
      ['response.success', '1 = matched, 42 = no match, other = error. Steam only exposes success=1 with a steamid you can use.'],
      ['response.steamid', 'Numeric 64-bit steamid you can feed into GetOwnedGames or the other library endpoints.'],
      ['response.message', 'Human-readable error string when success != 1.'],
    ],
  },
  protondb_summary: {
    title: 'ProtonDB summary (protondb.com/api/v1/reports/summaries/<appId>.json)',
    rows: [
      ['tier', "Aggregated tier the ProtonDB frontend renders: platinum / gold / silver / bronze / borked. Missing means ProtonDB has no data yet (found:false)."],
      ['confidence', "How confident the aggregation is in the tier -- low, moderate, good, strong. Drives the pill styling on the game page."],
      ['total', 'Number of user reports counted toward the tier. Under ~5 reports and confidence usually reads as low.'],
      ['trendingTier', 'Tier computed from the most recent reports only. When this diverges from tier, the game has recently gotten better or worse under Proton.'],
      ['bestReportedTier / worstReportedTier', 'Optimistic / pessimistic tier ever recorded. Wide spread means user experience varies a lot (hardware, Proton version, distro).'],
      ['score', "Numeric backing for tier. Higher = better. Used for sort ordering server-side; the pipeline doesn't rely on this directly."],
      ['found (added by our proxy)', 'true if ProtonDB returned data, false if the upstream 404d. Distinguishes "no reports yet" from an error.'],
    ],
  },
  protondb_counts: {
    title: 'ProtonDB global counts (protondb.com/data/counts.json)',
    rows: [
      ['games', 'Total number of games with at least one ProtonDB report.'],
      ['reports', 'Total number of individual reports across all games and all versions of Proton.'],
      ['users', 'Total number of distinct reporting users on ProtonDB.'],
      ['lastUpdated / date / timestamp', 'When ProtonDB last refreshed the counts (field name varies -- check what the raw JSON returns).'],
    ],
  },
  pcgw_by_appid: {
    title: 'PCGamingWiki Infobox_game by Steam App ID (Cargo)',
    rows: [
      ['cargoquery[].title.page', 'PCGW wiki page name for the match. Same page can bundle multiple appids (e.g. Half-Life 2 -> "220,219,323140,466270,290930").'],
      ['cargoquery[].title.appId', 'Full comma-list of Steam App IDs on this PCGW page.'],
      ['cargoquery[].title.gogId', 'GOG product ID if the page tracks it. Empty when the game is not on GOG.'],
      ['cargoquery[].title.engines', 'Comma-list with the wiki namespace prefix ("Engine:Source,Engine:Unity"). The enricher strips "Engine:" on read.'],
      ['cargoquery[].title.available', 'Native platforms as comma-list: Windows, OS X, Linux, DOS. Drives the pgw_os column (14) on search-index.'],
      ['cargoquery[].title.relWin / relLin / relMac / relDos', 'Per-OS release date. Presence + value both signal native support on that OS. relDos = null is common.'],
      ['cargoquery[].title.developers / publishers', 'Comma-list of dev + publisher pages. Aliased so Cargo does not reject the underscore prefix.'],
      ['error.info', 'MWException message when the query is malformed (bad field, wrong operator, blocked alias). The API returns HTTP 200 with this envelope -- watch for it.'],
    ],
  },
  pcgw_by_title: {
    title: 'PCGamingWiki Infobox_game by title (Cargo LIKE)',
    rows: [
      ['(same shape as pcgw_by_appid)', 'Rows are ordered by _pageName so results are stable across runs.'],
      ['cargoquery[].title.page', 'The wiki page that matched. Case-insensitive substring on _pageName -- e.g. "half-life" matches Half-Life, Half-Life 2, Half-Life: Alyx.'],
      ['(limit 20)', 'Client-side cap to keep the payload readable. Increase LIMIT in the fetcher if the tail is meaningful.'],
    ],
  },
  pcgw_table_fields: {
    title: 'PCGamingWiki cargofields (schema introspection)',
    rows: [
      ['cargofields.<FieldName>.type', 'Cargo data type: String / Text / Integer / Date / Page / File / URL / etc.'],
      ['cargofields.<FieldName>.isList', 'Empty string ("") when this is a virtual list field. Bulk WHERE clauses on virtual lists need the __full companion.'],
      ['cargofields.<FieldName>.delimiter', 'Delimiter for list fields (usually ",").'],
      ['(use case)', 'Handy when porting a new field into the pipeline enricher: check the real type before adding a query.'],
      ['(default table)', 'Empty term defaults to Infobox_game. Try Engine, Availability, Company, Series, or any name from action=cargotables.'],
    ],
  },
};

function _showFieldDocs(endpointKey) {
  const doc = FIELD_DOCS[endpointKey] || FIELD_DOCS.steam_appdetails;
  const existing = document.getElementById('apix-fields-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'apix-fields-modal';
  modal.className = 'apix-modal-overlay';
  const rows = doc.rows
    .map((r) => `<tr><th>${escapeHtml(r[0])}</th><td>${escapeHtml(r[1])}</td></tr>`)
    .join('');
  modal.innerHTML = `
    <div class="apix-modal">
      <div class="apix-modal-head">
        <h3>Field descriptions — ${escapeHtml(doc.title)}</h3>
        <button class="apix-modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="apix-modal-body">
        <table class="apix-fields-table">${rows}</table>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.apix-modal-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}

// Best-effort store-page URL for the current result, so the admin can jump to
// the game on the store. id endpoints build a direct product URL (GOG uses the
// product response's links.product_card); search endpoints link to the store's
// search for the term.
function _storeUrl(endpoint, id, term, payload) {
  if (endpoint === 'steam_appdetails' || endpoint === 'steam_deck') {
    return id ? `https://store.steampowered.com/app/${id}` : null;
  }
  if (endpoint === 'gog_product') {
    const card = payload && payload.data && payload.data.links && payload.data.links.product_card;
    return typeof card === 'string' && card ? card : null;
  }
  if (endpoint === 'gog_search') {
    return term ? `https://www.gog.com/en/games?query=${encodeURIComponent(term)}` : null;
  }
  if (endpoint === 'epic_search') {
    return term ? `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(term)}&sortBy=relevancy&sortDir=DESC` : null;
  }
  if (endpoint === 'protondb_summary') {
    return id ? `https://www.protondb.com/app/${id}` : null;
  }
  if (endpoint === 'protondb_counts') {
    return 'https://www.protondb.com/explore';
  }
  if (endpoint === 'pcgw_by_appid') {
    // PCGW ships an appid-to-page redirect endpoint that lands on the
    // canonical wiki entry for the game. Handy to compare our parsed data
    // against the rendered infobox.
    return id ? `https://www.pcgamingwiki.com/api/appid.php?appid=${encodeURIComponent(id)}` : null;
  }
  if (endpoint === 'pcgw_by_title' || endpoint === 'pcgw_table_fields') {
    return term ? `https://www.pcgamingwiki.com/w/index.php?search=${encodeURIComponent(term)}` : null;
  }
  return null;
}

// Format the steam_store_redirect hops as a `curl -L -v`-style trace. Each
// hop becomes 3-4 lines: request line, status line, optional Location line,
// and (on the final hop) the Content-Type. Reads left-to-right so admins can
// see the redirect chain without decoding raw JSON. #199
function _formatHopTrace(hops) {
  if (!Array.isArray(hops) || hops.length === 0) return '';
  const lines = ['# Redirect trace (curl -L -v style)'];
  for (const h of hops) {
    lines.push(`> ${h.method || 'GET'} ${h.url}`);
    lines.push(`< HTTP ${h.status} ${h.status_text || ''}`.trimEnd());
    if (h.location) lines.push(`< Location: ${h.location}`);
    if (h.content_type && !h.location) lines.push(`< Content-Type: ${h.content_type}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

let _index = null;
async function _loadIndex() {
  if (_index) return _index;
  try {
    const r = await fetch(await dataUrl('search-index.json'));
    _index = r.ok ? await r.json() : [];
  } catch {
    _index = [];
  }
  return _index;
}

// Resolve the input for the current store + endpoint arg. 'term' endpoints pass
// the text straight through. 'id' endpoints take a numeric id, or a name that we
// match against the search index (scoped to the store; GOG/Epic ids are stored
// prefixed, so we strip the prefix to get the store-native id).
async function _resolveArg(store, endpointArg, input) {
  const q = String(input || '').trim();
  // Argless endpoints (featured / featuredcategories): skip input parsing so
  // admins can just click Fetch without typing anything.
  if (endpointArg === 'none') return { id: '', title: '' };
  if (!q) return { error: 'Enter an ID, name, or search term.' };
  if (endpointArg === 'term') return { term: q };
  // Keyed Steam Web API endpoints (#221): steamid is a numeric 17-digit id,
  // vanity is the alphanumeric profile name. Both are passed straight through.
  if (endpointArg === 'steamid') {
    if (!/^\d{5,20}$/.test(q)) return { error: 'Steam ID must be a numeric 17-digit value (starts with 7656...).' };
    return { steamid: q };
  }
  if (endpointArg === 'vanity') {
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(q)) return { error: 'Vanity URL is the profile name (letters, digits, _ or -).' };
    return { vanityurl: q };
  }
  if (/^\d+$/.test(q)) return { id: q };
  const idx = await _loadIndex();
  const ql = q.toLowerCase();
  const prefix = store === 'gog' ? 'gog:' : store === 'epic' ? 'epic:' : '';
  const inStore = (r) => {
    if (!Array.isArray(r)) return false;
    const sid = String(r[0]);
    // ProtonDB (#280) + PCGamingWiki (#377) are both keyed by Steam appid,
    // so a name-to-id resolve for those tabs walks the Steam entries.
    if (store === 'steam' || store === 'protondb' || store === 'pcgamingwiki') {
      return r[5] === 'steam' || /^\d+$/.test(sid);
    }
    return sid.startsWith(prefix);
  };
  const exact = idx.find((r) => inStore(r) && String(r[1] || '').toLowerCase() === ql);
  const match = exact || idx.find((r) => inStore(r) && String(r[1] || '').toLowerCase().includes(ql));
  if (!match) return { error: `No ${store} game matched "${q}".` };
  let id = String(match[0]);
  if (prefix && id.startsWith(prefix)) id = id.slice(prefix.length);
  return { id, title: String(match[1] || '') };
}

// #221: `canManageAdmins` gates the three keyed Steam Web API endpoints
// (GetOwnedGames / GetRecentlyPlayedGames / ResolveVanityURL). Passed
// through from main.js so we don't need to duplicate the permission
// resolution logic here.
export function renderApiExplorer({ canManageAdmins = false } = {}) {
  const el = document.getElementById('api-explorer-content');
  if (!el) return;

  let store = 'steam';
  let lastJson = '';
  let lastName = 'store';
  let lastPayload = null;

  const storeTabs = Object.entries(STORES)
    .map(([k, s]) => `<button class="apix-store-tab${k === store ? ' active' : ''}" data-store="${k}" type="button">${escapeHtml(s.label)}</button>`)
    .join('');

  el.innerHTML = `
    <div class="admin-card" style="padding:14px 16px; margin-bottom:16px">
      <div class="admin-subhead">Store API Explorer</div>
      <p class="admin-hint" style="margin:6px 0 10px">Inspect the raw JSON a store endpoint returns. Fetched server-side because the stores are CORS-blocked from the browser.</p>
      <div class="apix-store-tabs">${storeTabs}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px">
        <input id="apix-input" class="admin-input" type="text" placeholder="${escapeHtml(STORES[store].placeholder)}" style="flex:0 1 300px; min-width:0">
        <select id="apix-endpoint" class="admin-select" title="Which endpoint to fetch"></select>
        <button id="apix-fetch" class="admin-btn admin-btn--primary">Fetch</button>
        <button id="apix-fields" class="admin-btn" type="button" title="What the JSON fields mean">Field descriptions</button>
      </div>
      <p id="apix-status" class="admin-hint" style="margin:10px 0 0" hidden></p>
      <div id="apix-toolbar" class="apix-toolbar" hidden>
        <label class="apix-wrap-toggle"><input type="checkbox" id="apix-wrap"> Word wrap</label>
        <label class="apix-wrap-toggle" title="Show the full edge-function envelope (endpoint, arg, url, status, data) instead of just the parsed data field"><input type="checkbox" id="apix-raw"> Full envelope</label>
        <button id="apix-copy" class="admin-btn" type="button">Copy JSON</button>
        <button id="apix-download" class="admin-btn" type="button">Download JSON</button>
        <a id="apix-store-link" class="admin-btn" target="_blank" rel="noopener" hidden>Open store page &#8599;</a>
      </div>

      <!-- REQUEST section: what we actually asked the upstream store for.
           Always visible after a fetch so admins can see method, URL, and
           the parameters we sent (like Postman / any real API explorer). -->
      <div id="apix-req-section" class="apix-req-section" hidden>
        <div class="apix-section-label">Request</div>
        <div class="apix-req-line"><span class="apix-req-key">Endpoint:</span> <code id="apix-req-endpoint"></code></div>
        <div class="apix-req-line"><span class="apix-req-key">Method:</span> <code id="apix-req-method"></code></div>
        <div class="apix-req-line"><span class="apix-req-key">Upstream URL:</span> <a id="apix-req-url" target="_blank" rel="noopener"></a></div>
        <div class="apix-req-line"><span class="apix-req-key">Params:</span> <code id="apix-req-params"></code></div>
      </div>

      <!-- RESPONSE section: status line + the actual body. Raw envelope toggle
           swaps between the parsed data field and the full edge-function
           envelope (endpoint, arg, url, status, data). -->
      <div id="apix-resp-section" class="apix-req-section" hidden>
        <div class="apix-section-label">Response <span id="apix-resp-status" class="apix-req-key"></span></div>
      </div>
      <!-- Results index: rendered for endpoints that come back with a list
           (e.g. PCGamingWiki title search). Each row is a clickable button
           that refills the input with the exact page name and refetches so
           an admin can drill into one specific match without scrolling
           through a 20-row JSON blob. -->
      <div id="apix-results-index" class="apix-results-index" hidden></div>
      <pre id="apix-output" class="apix-output" hidden></pre>

      <div id="apix-followup-header" class="admin-hint" hidden style="margin-top:14px;color:var(--accent);font-weight:600"></div>
      <pre id="apix-hop-trace" class="apix-output apix-hop-trace" hidden style="margin-top:6px"></pre>
      <pre id="apix-followup" class="apix-output" hidden style="margin-top:6px;border-left:3px solid var(--accent);padding-left:12px"></pre>
    </div>`;

  const endpointSel = el.querySelector('#apix-endpoint');
  const inputEl = el.querySelector('#apix-input');

  const populateEndpoints = () => {
    // Hide admin-gated endpoints when the current user lacks manage_admins.
    // The edge fn also refuses to run for non-admins (defense in depth); this
    // just keeps the dropdown clean so we don't tempt regular signed-in users
    // with options that would 403. #221.
    const list = STORES[store].endpoints.filter(
      (e) => !e.adminGated || canManageAdmins,
    );
    endpointSel.innerHTML = list
      .map((e) => `<option value="${e.key}" data-arg="${e.arg}"${e.placeholder ? ` data-placeholder="${escapeHtml(e.placeholder)}"` : ''}>${escapeHtml(e.label)}</option>`)
      .join('');
    // Placeholder updates with the currently selected endpoint. An endpoint's
    // own `placeholder` beats the arg-type default beats the store default,
    // so switching from a numeric-appid endpoint to a table-name endpoint
    // shows "Cargo table name" instead of a stale "App ID or name" hint.
    const updatePlaceholder = () => {
      const opt = endpointSel.options[endpointSel.selectedIndex];
      const arg = opt?.dataset.arg || 'id';
      const perEndpoint = opt?.dataset.placeholder;
      const hint = perEndpoint
        || (arg === 'steamid' ? 'Steam ID (17 digits, e.g. 76561197960287930)'
          : arg === 'vanity' ? 'Vanity URL profile name (e.g. gaben)'
          : STORES[store].placeholder);
      inputEl.placeholder = hint;
      // Clear a stale numeric appid when the user switches to the Cargo table
      // name endpoint. Without this the input still says "220" from the
      // previous pcgw_by_appid call and gets rejected as "not a table name".
      if (opt?.value === 'pcgw_table_fields' && /^\d+$/.test(inputEl.value.trim())) {
        inputEl.value = '';
      }
    };
    updatePlaceholder();
    endpointSel.onchange = updatePlaceholder;
  };
  populateEndpoints();

  const setStatus = (text, isError) => {
    const s = document.getElementById('apix-status');
    if (!s) return;
    s.hidden = false;
    s.textContent = text;
    s.className = 'admin-hint' + (isError ? ' admin-error' : '');
  };

  const doFetch = async () => {
    const opt = endpointSel.options[endpointSel.selectedIndex];
    const endpoint = opt?.value;
    const arg = opt?.dataset.arg || 'id';
    setStatus('Resolving...');
    const resolved = await _resolveArg(store, arg, inputEl.value);
    if (resolved.error) { setStatus(resolved.error, true); return; }
    const label = arg === 'none'
      ? '(no argument)'
      : resolved.steamid
        ? `steamid ${resolved.steamid}`
        : resolved.vanityurl
          ? `vanity "${resolved.vanityurl}"`
          : resolved.id
            ? `app ${resolved.id}${resolved.title ? ` (${resolved.title})` : ''}`
            : `"${resolved.term}"`;
    setStatus(`Fetching ${endpoint} for ${label}...`);
    const btn = document.getElementById('apix-fetch');
    if (btn) btn.disabled = true;
    // #221: keyed endpoints go through the admin-only proxy. Public endpoints
    // stay on steam-explore. isLibraryEndpoint keeps the routing in one place.
    // #377: PCGamingWiki bypasses the edge fn entirely because PGWiki is
    // CORS-enabled + public. Client-side fetch returns the same envelope
    // shape so the rest of this function does not need to branch.
    let payload;
    if (store === 'pcgamingwiki') {
      payload = await exploreCargoPCGamingWiki(endpoint, { id: resolved.id, term: resolved.term });
    } else if (isLibraryEndpoint(endpoint)) {
      payload = await lookupLibrary(endpoint, { steamid: resolved.steamid, vanityurl: resolved.vanityurl });
    } else {
      payload = await exploreStore(endpoint, { id: resolved.id, term: resolved.term });
    }
    if (btn) btn.disabled = false;
    lastPayload = payload;
    const rawMode = document.getElementById('apix-raw')?.checked;
    lastJson = JSON.stringify(rawMode ? payload : (payload && 'data' in payload ? payload.data : payload), null, 2);
    lastName = `${endpoint}-${resolved.id || resolved.steamid || resolved.vanityurl || (resolved.term || '').replace(/\W+/g, '-').slice(0, 40)}`;
    const out = document.getElementById('apix-output');
    if (out) { out.hidden = false; out.textContent = lastJson; }
    document.getElementById('apix-toolbar').hidden = false;

    // Populate the Request + Response sections so admins see the full round
    // trip: endpoint key, HTTP method, actual upstream URL, params we sent.
    // Postman-style layout. #199
    const reqSection = document.getElementById('apix-req-section');
    const respSection = document.getElementById('apix-resp-section');
    if (reqSection && respSection) {
      reqSection.hidden = false;
      respSection.hidden = false;
      const setText = (id, val) => { const n = document.getElementById(id); if (n) n.textContent = val; };
      setText('apix-req-endpoint', endpoint);
      setText('apix-req-method', payload?.method || 'GET');
      const upstreamUrl = payload?.url || '(unknown)';
      const urlEl = document.getElementById('apix-req-url');
      if (urlEl) { urlEl.textContent = upstreamUrl; urlEl.href = upstreamUrl; }
      const paramsStr = arg === 'none'
        ? '(none)'
        : resolved.id
          ? `id=${resolved.id}`
          : `term="${resolved.term}"`;
      setText('apix-req-params', paramsStr);
      setText('apix-resp-status', `HTTP ${payload?.status ?? (payload?.ok ? 200 : 'ERR')}`);
    }

    // Results index (#377): when pcgw_by_title comes back with a Cargo
    // rowset, render each row as a clickable button so an admin can drill
    // into one specific match without scrolling the raw JSON. Click refills
    // the input with the EXACT page name and refetches, which narrows the
    // LIKE match to a single row.
    const resultsEl = document.getElementById('apix-results-index');
    if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ''; }
    if (endpoint === 'pcgw_by_title' && resultsEl && Array.isArray(payload?.data?.cargoquery)) {
      const rows = payload.data.cargoquery
        .map((r) => (r && typeof r === 'object' ? r.title : null))
        .filter((t) => t && typeof t === 'object' && t.page);
      if (rows.length > 1) {
        // Show the picker only when it actually narrows -- a single-row
        // response already IS the drilled-in view.
        const items = rows.map((row) => {
          const page = String(row.page);
          const appId = String(row.appId || '').split(',')[0].trim();
          const meta = appId ? ` -- Steam appid ${escapeHtml(appId)}` : ' -- no Steam ID';
          return `<button type="button" class="apix-result-item" data-page="${escapeHtml(page)}">${escapeHtml(page)}<span class="apix-result-meta">${meta}</span></button>`;
        }).join('');
        resultsEl.hidden = false;
        resultsEl.innerHTML = `<div class="apix-results-head">${rows.length} matches -- click to drill in:</div>${items}`;
        resultsEl.querySelectorAll('.apix-result-item').forEach((btn) => {
          btn.addEventListener('click', () => {
            inputEl.value = btn.dataset.page || '';
            doFetch();
          });
        });
      }
    }

    // Hop-by-hop redirect trace (curl -L -v style). Rendered when the caller
    // chose steam_store_redirect directly, or when the auto follow-up fires
    // one below.
    const hopEl = document.getElementById('apix-hop-trace');
    if (hopEl) { hopEl.hidden = true; hopEl.textContent = ''; }
    if (endpoint === 'steam_store_redirect' && Array.isArray(payload?.data?.hops) && hopEl) {
      hopEl.hidden = false;
      hopEl.textContent = _formatHopTrace(payload.data.hops);
    }

    // #199: auto follow-up. If appdetails came back with success:false for
    // this appid, fire a store-page redirect probe so the admin sees whether
    // Steam replaced this appid with a newer one without having to switch
    // endpoints and re-fetch.
    const followupEl = document.getElementById('apix-followup');
    const followupHeader = document.getElementById('apix-followup-header');
    if (followupEl) { followupEl.hidden = true; followupEl.textContent = ''; }
    if (followupHeader) { followupHeader.hidden = true; followupHeader.textContent = ''; }
    if (endpoint === 'steam_appdetails' && resolved.id && payload?.data && payload.data[String(resolved.id)]?.success === false && followupEl && followupHeader) {
      followupHeader.hidden = false;
      followupHeader.textContent = 'Auto follow-up: steam_store_redirect (Steam said success:false, checking if the appid was replaced)';
      followupEl.hidden = false;
      followupEl.textContent = 'Probing store page...';
      const redirect = await exploreStore('steam_store_redirect', { id: resolved.id });
      // Show the same hop trace above the JSON so admins see the curl-style
      // redirect chain immediately after the appdetails call.
      if (hopEl && Array.isArray(redirect?.data?.hops)) {
        hopEl.hidden = false;
        hopEl.textContent = _formatHopTrace(redirect.data.hops);
      }
      followupEl.textContent = JSON.stringify(rawMode ? redirect : redirect.data || redirect, null, 2);
      if (redirect?.data?.replaced_by) {
        followupHeader.textContent = `Auto follow-up: Steam replaced appid ${resolved.id} -> ${redirect.data.replaced_by}`;
      }
    }
    const storeLink = document.getElementById('apix-store-link');
    if (storeLink) {
      const u = _storeUrl(endpoint, resolved.id, resolved.term, payload);
      if (u) { storeLink.href = u; storeLink.hidden = false; } else { storeLink.hidden = true; }
    }
    setStatus(
      payload.ok ? `HTTP ${payload.status || 200} — ${payload.url || ''}` : `Failed: ${payload.error || 'unknown'}`,
      !payload.ok,
    );
  };

  el.querySelectorAll('.apix-store-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      store = tab.dataset.store;
      el.querySelectorAll('.apix-store-tab').forEach((t) => t.classList.toggle('active', t === tab));
      populateEndpoints();
    });
  });

  el.querySelector('#apix-fetch')?.addEventListener('click', doFetch);
  inputEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doFetch(); } });
  el.querySelector('#apix-fields')?.addEventListener('click', () => {
    _showFieldDocs(endpointSel.value || 'steam_appdetails');
  });
  el.querySelector('#apix-wrap')?.addEventListener('change', (e) => {
    document.getElementById('apix-output')?.classList.toggle('apix-wrap', e.target.checked);
    document.getElementById('apix-followup')?.classList.toggle('apix-wrap', e.target.checked);
    document.getElementById('apix-hop-trace')?.classList.toggle('apix-wrap', e.target.checked);
  });
  // #199: Raw mode swaps between the parsed data field (default) and the
  // full edge-function envelope (endpoint, arg, url, status, data). Re-serializes
  // the last fetch so admins can toggle without re-fetching.
  el.querySelector('#apix-raw')?.addEventListener('change', (e) => {
    if (!lastPayload) return;
    const rawMode = e.target.checked;
    lastJson = JSON.stringify(rawMode ? lastPayload : (lastPayload && 'data' in lastPayload ? lastPayload.data : lastPayload), null, 2);
    const out = document.getElementById('apix-output');
    if (out) out.textContent = lastJson;
  });
  el.querySelector('#apix-copy')?.addEventListener('click', async () => {
    if (!lastJson) return;
    try { await navigator.clipboard.writeText(lastJson); setStatus('Copied JSON to clipboard.'); }
    catch { setStatus('Copy failed -- select the text and copy manually.', true); }
  });
  el.querySelector('#apix-download')?.addEventListener('click', () => {
    if (!lastJson) return;
    const blob = new Blob([lastJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${lastName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
