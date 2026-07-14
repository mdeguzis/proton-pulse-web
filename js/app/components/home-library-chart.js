// Signed-in-only home page section: horizontal bar chart of the rating
// breakdown across the user's cached Steam library (#199) or wishlist (#266).
// Chips next to the title swap the view. Device views (#273) show Steam Deck /
// Steam Machine / SteamOS compatibility breakdowns of the library.
import { getMyLibraryAppIds } from '../lib/user-library.js?v=1d8e72df';
import { getMyWishlistAppIds } from '../lib/user-wishlist.js?v=9c88bc65';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { RATING_COLORS, RATING_TEXT } from '../config.js?v=f9591262';
import { esc } from '../utils.js?v=2cbe4072';
import { loadDeckStatusMap } from '../api/deck-status.js?v=a8d355d8';

const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
const TIER_LABEL = {
  platinum: 'Platinum', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', borked: 'Borked',
};

// Status colors shared by the device compat rows. Muted so the device rows
// don't compete with the accent-colored ProtonDB tier bars.
const STATUS_COLORS = {
  verified:    { bg: '#3a9250', fg: '#fff' },
  playable:    { bg: '#c8a050', fg: '#111' },
  compatible:  { bg: '#3a7fc8', fg: '#fff' },
  unsupported: { bg: '#c85050', fg: '#fff' },
  unknown:     { bg: '#4a5563', fg: '#c8d4e0' },
};

// Per-device chart config (#273). `field` is the deck-status.json entry key:
// Steam Deck reads the legacy `status`; Machine / SteamOS read their own.
const DEVICE = {
  deck: {
    field: 'status',
    order: ['verified', 'playable', 'unsupported', 'unknown'],
    label: { verified: 'Deck Verified', playable: 'Deck Playable', unsupported: 'Unsupported', unknown: 'Not rated' },
    title: "Your Library's compatibility with Steam Deck", chip: 'Steam Deck', icon: 'icon-steam-deck',
  },
  machine: {
    field: 'machine',
    order: ['verified', 'playable', 'unsupported', 'unknown'],
    label: { verified: 'Verified', playable: 'Playable', unsupported: 'Unsupported', unknown: 'Not rated' },
    title: "Your Library's compatibility with the Steam Machine", chip: 'Steam Machine', icon: 'icon-steam-machine',
  },
  steamos: {
    field: 'steamos',
    order: ['compatible', 'unsupported', 'unknown'],
    label: { compatible: 'Compatible', unsupported: 'Unsupported', unknown: 'Not rated' },
    title: "Your Library's compatibility with SteamOS", chip: 'SteamOS', icon: 'icon-steamos',
  },
};

/**
 * Tally per-status counts for a device compat field over an appId set.
 * `field` is the deck-status.json key ('status' for Deck, 'machine', 'steamos');
 * `order` lists the buckets, with 'unknown' the catch-all for anything missing.
 */
export function computeDeviceStatusCounts(appIdSet, deckMap, field, order) {
  const counts = {};
  for (const k of order) counts[k] = 0;
  if (!appIdSet || appIdSet.size === 0) return counts;
  for (const id of appIdSet) {
    const entry = deckMap ? deckMap[String(id)] : null;
    let status = (entry && entry[field]) || 'unknown';
    if (!Object.prototype.hasOwnProperty.call(counts, status)) status = 'unknown';
    counts[status] += 1;
  }
  return counts;
}

/**
 * Steam Deck status counts. Thin wrapper over computeDeviceStatusCounts so
 * existing callers and tests keep working.
 */
export function computeDeckStatusCounts(appIdSet, deckMap) {
  return computeDeviceStatusCounts(appIdSet, deckMap, 'status', DEVICE.deck.order);
}

/**
 * Compute a tier -> count map for the intersection of appIds and search-index
 * entries. Exported so tests can pin the aggregation without touching the DOM.
 */
export function computeLibraryTierCounts(appIdSet, indexRows) {
  const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0, pending: 0, unrated: 0 };
  if (!appIdSet || appIdSet.size === 0 || !Array.isArray(indexRows)) return counts;
  for (const row of indexRows) {
    const appId = Number(row?.[0]);
    if (!Number.isFinite(appId) || !appIdSet.has(appId)) continue;
    const tier = String(row?.[2] || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, tier)) counts[tier] += 1;
    else if (tier === 'native') counts.platinum += 1;
    else counts.unrated += 1;
  }
  return counts;
}

const VIEW_COPY = {
  library:  { title: 'Your library at a glance',  noun: 'owned',      empty: 'No Steam library synced yet.',  sync: 'library'  },
  wishlist: { title: 'Your wishlist at a glance', noun: 'wishlisted', empty: 'No Steam wishlist synced yet.', sync: 'wishlist' },
};

function _copyFor(view) {
  if (DEVICE[view]) return { title: DEVICE[view].title, noun: 'owned', empty: 'No Steam library synced yet.', sync: 'library' };
  return VIEW_COPY[view] || VIEW_COPY.library;
}

function _renderChipsHtml(view) {
  const deviceChip = (key) => {
    const cfg = DEVICE[key];
    return `<button type="button" class="hlc-chip hlc-chip--device${view === key ? ' hlc-chip--active' : ''}" data-view="${key}" role="tab" aria-selected="${view === key}" title="${esc(cfg.chip)} compatibility" aria-label="${esc(cfg.chip)}"><svg class="hlc-chip-glyph" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><use href="#${cfg.icon}"/></svg><span class="hlc-chip-text">${esc(cfg.chip)}</span></button>`;
  };
  return `
    <div class="hlc-chips" role="tablist" aria-label="Chart view">
      <button type="button" class="hlc-chip${view === 'library'  ? ' hlc-chip--active' : ''}" data-view="library"  role="tab" aria-selected="${view === 'library'}">Library</button>
      <button type="button" class="hlc-chip${view === 'wishlist' ? ' hlc-chip--active' : ''}" data-view="wishlist" role="tab" aria-selected="${view === 'wishlist'}">Wishlist</button>
      ${deviceChip('deck')}${deviceChip('machine')}${deviceChip('steamos')}
    </div>`;
}

function _bar(labelText, bg, fg, pct, n, href) {
  // A single row -- rendered as <a> when we can deep-link to the browse view
  // filtered to this bucket (#290), and a plain <div> otherwise (e.g. empty
  // rows or scopes with no reachable filter). The filter itself is applied by
  // home.js reading the URL params on load.
  const attrs = href ? `href="${esc(href)}" class="hlc-row hlc-row--link"` : `class="hlc-row"`;
  const tag = href ? 'a' : 'div';
  return `
        <${tag} ${attrs}>
          <div class="hlc-label" style="color:${fg};background:${bg}">${esc(labelText)}</div>
          <div class="hlc-track"><div class="hlc-fill" style="width:${pct}%;background:${bg}"></div></div>
          <div class="hlc-count">${n.toLocaleString()}</div>
        </${tag}>`;
}

// Which base scope (?filter=) the row's link should carry. Library, Wishlist,
// and the three device views all narrow to the user's owned games except for
// wishlist, which uses its own list.
function _scopeParam(view) {
  return view === 'wishlist' ? 'wishlist' : 'mine';
}

// Map a chart row to an app.html URL that lands with the matching pill
// pre-selected. Returns null when the row cannot be represented as a filter
// (e.g. Unknown status has no picker equivalent yet). The `view` param
// travels along so the home page chart chip stays on the same tab (Deck /
// Machine / SteamOS / Wishlist) when the user comes back -- otherwise
// home.js's preferredSource override would reset it to Library.
function _rowHref(view, bucket) {
  const scope = _scopeParam(view);
  if (DEVICE[view]) {
    if (bucket === 'unknown') return null;
    return `app.html?filter=${scope}&${view}=${encodeURIComponent(bucket)}&view=${view}`;
  }
  return `app.html?filter=${scope}&tier=${encodeURIComponent(bucket)}&view=${view}`;
}

function _renderChartHtml(view, appIds, deckMap) {
  const copy = _copyFor(view);
  const chipsHtml = _renderChipsHtml(view);
  const deviceClass = DEVICE[view] ? ' home-library-chart--device' : '';
  if (!appIds || appIds.size === 0) {
    return `
      <div class="home-library-chart home-library-chart--empty${deviceClass}">
        <div class="hlc-header">
          <div class="hlc-title">${esc(copy.title)}</div>
          ${chipsHtml}
        </div>
        <div class="hlc-empty-body">
          ${esc(copy.empty)}
          <a href="profile.html">Sync your ${esc(copy.sync)}</a> to see a compatibility breakdown here.
        </div>
      </div>`;
  }
  const total = appIds.size;
  let barsHtml = '';
  let subtitle = '';
  if (DEVICE[view]) {
    const cfg = DEVICE[view];
    const counts = computeDeviceStatusCounts(appIds, deckMap || {}, cfg.field, cfg.order);
    const rated = cfg.order.filter((k) => k !== 'unknown').reduce((s, k) => s + (counts[k] || 0), 0);
    const max = Math.max(1, ...cfg.order.map((k) => counts[k] || 0));
    subtitle = `${rated.toLocaleString()} of ${total.toLocaleString()} ${esc(copy.noun)} games have a ${esc(cfg.chip)} rating.`;
    barsHtml = cfg.order.map((k) => {
      const n = counts[k] || 0;
      const pct = Math.round((n / max) * 100);
      const { bg, fg } = STATUS_COLORS[k] || STATUS_COLORS.unknown;
      return _bar(cfg.label[k], bg, fg, pct, n, n > 0 ? _rowHref(view, k) : null);
    }).join('');
  } else {
    const counts = computeLibraryTierCounts(appIds, searchIndex);
    const rated = TIER_ORDER.reduce((sum, t) => sum + (counts[t] || 0), 0);
    const maxBar = Math.max(1, ...TIER_ORDER.map((t) => counts[t] || 0));
    subtitle = `${rated.toLocaleString()} of ${total.toLocaleString()} ${esc(copy.noun)} games have compatibility data.`;
    barsHtml = TIER_ORDER.map((tier) => {
      const n = counts[tier] || 0;
      const pct = Math.round((n / maxBar) * 100);
      const bg = RATING_COLORS[tier] || '#3a4a5a';
      const fg = RATING_TEXT[tier] || '#c8d4e0';
      return _bar(TIER_LABEL[tier], bg, fg, pct, n, n > 0 ? _rowHref(view, tier) : null);
    }).join('');
  }
  return `
    <div class="home-library-chart${deviceClass}">
      <div class="hlc-header">
        <div class="hlc-title">${esc(copy.title)}</div>
        ${chipsHtml}
      </div>
      <div class="hlc-subtitle">${subtitle}</div>
      <div class="hlc-bars">${barsHtml}</div>
    </div>`;
}

const HLC_VIEW_KEY = 'pp:hlc-view';
const VALID_VIEWS = new Set(['library', 'wishlist', 'deck', 'machine', 'steamos']);
function _readView() {
  try {
    const v = localStorage.getItem(HLC_VIEW_KEY);
    return VALID_VIEWS.has(v) ? v : 'library';
  } catch { return 'library'; }
}
function _writeView(v) {
  try { localStorage.setItem(HLC_VIEW_KEY, VALID_VIEWS.has(v) ? v : 'library'); } catch { /* ignore */ }
}

async function _fetchAppIds(view) {
  // Device views + library scope to owned games; wishlist to the wishlist.
  if (view === 'wishlist') return getMyWishlistAppIds().catch(() => new Set());
  return getMyLibraryAppIds().catch(() => new Set());
}

export async function renderHomeLibraryChart(mountEl, { preferredSource } = {}) {
  if (!mountEl) return;
  const session = await window.SupaAuth?.getSession?.();
  if (!session?.user) {
    mountEl.innerHTML = '';
    return;
  }
  await loadSearchIndex().catch(() => null);
  // Nav-driven override maps the ?filter= hint into the view chip.
  let view = preferredSource === 'library' || preferredSource === 'wishlist'
    ? preferredSource
    : _readView();
  if (preferredSource) _writeView(view);
  let [appIds, deckMap] = await Promise.all([
    _fetchAppIds(view),
    loadDeckStatusMap().catch(() => ({})),
  ]);
  mountEl.innerHTML = _renderChartHtml(view, appIds, deckMap);
  mountEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.hlc-chip');
    if (!btn) return;
    const next = btn.dataset.view;
    if (!VALID_VIEWS.has(next) || next === view) return;
    view = next;
    _writeView(view);
    const busy = mountEl.querySelector('.hlc-bars, .hlc-empty-body');
    if (busy) busy.style.opacity = '0.4';
    appIds = await _fetchAppIds(view);
    mountEl.innerHTML = _renderChartHtml(view, appIds, deckMap);
  });
}
