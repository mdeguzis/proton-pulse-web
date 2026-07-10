// Signed-in-only home page section: horizontal bar chart showing the rating
// breakdown across the user's cached Steam library (#199) or Steam wishlist
// (#266 refinement). Two chips ("Library" / "Wishlist") next to the title
// swap the source; only one is selected at a time.
import { getMyLibraryAppIds } from '../lib/user-library.js?v=1d8e72df';
import { getMyWishlistAppIds } from '../lib/user-wishlist.js?v=9c88bc65';
import { loadSearchIndex, searchIndex } from './search.js?v=598aaad1';
import { RATING_COLORS, RATING_TEXT } from '../config.js?v=f9591262';
import { esc } from '../utils.js?v=c7e1268c';
import { loadDeckStatusMap } from '../api/deck-status.js?v=456b6112';

const TIER_ORDER = ['platinum', 'gold', 'silver', 'bronze', 'borked'];
const TIER_LABEL = {
  platinum: 'Platinum',
  gold:     'Gold',
  silver:   'Silver',
  bronze:   'Bronze',
  borked:   'Borked',
};

// Steam Deck compat categories from Valve's deck-status.json feed. Order
// is the same as the pipeline map so the row reads top-to-bottom in a
// natural "best -> worst" order.
const DECK_ORDER = ['verified', 'playable', 'unsupported', 'unknown'];
const DECK_LABEL = {
  verified:    'Deck Verified',
  playable:    'Deck Playable',
  unsupported: 'Unsupported',
  unknown:     'Not rated',
};
// Muted, low-saturation greens/orange so the deck row does not compete
// visually with the accent-colored ProtonDB tier bars above.
const DECK_COLORS = {
  verified:    { bg: '#3a9250', fg: '#fff' },
  playable:    { bg: '#c8a050', fg: '#111' },
  unsupported: { bg: '#c85050', fg: '#fff' },
  unknown:     { bg: '#4a5563', fg: '#c8d4e0' },
};

/**
 * Intersect appIds with the pipeline's deck-status.json map and tally
 * counts per category. Missing entries bucket into "unknown" since
 * Valve just hasn't rated the app yet (the enricher published for
 * ~9.5k apps as of this writing).
 */
export function computeDeckStatusCounts(appIdSet, deckMap) {
  const counts = { verified: 0, playable: 0, unsupported: 0, unknown: 0 };
  if (!appIdSet || appIdSet.size === 0) return counts;
  for (const id of appIdSet) {
    const entry = deckMap ? deckMap[String(id)] : null;
    const status = (entry && entry.status) || 'unknown';
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/**
 * Compute a tier -> count map for the intersection of appIds and search-index
 * entries. Exported so tests can pin down the aggregation logic without
 * touching the DOM.
 */
export function computeLibraryTierCounts(appIdSet, indexRows) {
  const counts = { platinum: 0, gold: 0, silver: 0, bronze: 0, borked: 0, pending: 0, unrated: 0 };
  if (!appIdSet || appIdSet.size === 0 || !Array.isArray(indexRows)) return counts;
  for (const row of indexRows) {
    const appId = Number(row?.[0]);
    if (!Number.isFinite(appId) || !appIdSet.has(appId)) continue;
    const tier = String(row?.[2] || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, tier)) {
      counts[tier] += 1;
    } else if (tier === 'native') {
      counts.platinum += 1;
    } else {
      counts.unrated += 1;
    }
  }
  return counts;
}

// Copy per view. 'library' + 'wishlist' show a ProtonDB tier breakdown of
// their respective appid Set. 'deck' shows a Steam Deck compat breakdown
// of the library (users care about Deck for what they own; a wishlist-
// scoped deck view can follow later if asked). One view at a time keeps
// the panel compact instead of showing both bar groups at once.
const VIEW_COPY = {
  library:  { title: 'Your library at a glance',  noun: 'owned',      empty: 'No Steam library synced yet.',  sync: 'library'  },
  wishlist: { title: 'Your wishlist at a glance', noun: 'wishlisted', empty: 'No Steam wishlist synced yet.', sync: 'wishlist' },
  deck:     { title: 'Your Steam Deck at a glance', noun: 'owned',    empty: 'No Steam library synced yet.',  sync: 'library'  },
};

function _renderChipsHtml(view) {
  // Deck chip carries both the Steam Deck brand mark (D-shield with the
  // blue-purple gradient dot) AND the "Steam Deck" text. CSS hides the
  // text on narrow viewports so mobile shows just the logo, keeping the
  // chip row on one line without cramming.
  return `
    <div class="hlc-chips" role="tablist" aria-label="Chart view">
      <button type="button" class="hlc-chip${view === 'library'  ? ' hlc-chip--active' : ''}" data-view="library"  role="tab" aria-selected="${view === 'library'}">Library</button>
      <button type="button" class="hlc-chip${view === 'wishlist' ? ' hlc-chip--active' : ''}" data-view="wishlist" role="tab" aria-selected="${view === 'wishlist'}">Wishlist</button>
      <button type="button" class="hlc-chip hlc-chip--deck${view === 'deck' ? ' hlc-chip--active' : ''}" data-view="deck" role="tab" aria-selected="${view === 'deck'}" title="Steam Deck compatibility" aria-label="Steam Deck">
        <svg class="hlc-chip-glyph" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><use href="#icon-steam-deck"/></svg><span class="hlc-chip-text">Steam Deck</span>
      </button>
    </div>`;
}

function _renderChartHtml(view, appIds, deckMap) {
  const copy = VIEW_COPY[view] || VIEW_COPY.library;
  const chipsHtml = _renderChipsHtml(view);
  if (!appIds || appIds.size === 0) {
    return `
      <div class="home-library-chart home-library-chart--empty">
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
  if (view === 'deck') {
    const deckCounts = computeDeckStatusCounts(appIds, deckMap || {});
    const deckMax = Math.max(1, ...DECK_ORDER.map((k) => deckCounts[k] || 0));
    const rated = DECK_ORDER.filter((k) => k !== 'unknown').reduce((s, k) => s + (deckCounts[k] || 0), 0);
    subtitle = `${rated.toLocaleString()} of ${total.toLocaleString()} ${esc(copy.noun)} games have a Steam Deck rating.`;
    barsHtml = DECK_ORDER.map((k) => {
      const n = deckCounts[k] || 0;
      const pct = Math.round((n / deckMax) * 100);
      const { bg, fg } = DECK_COLORS[k];
      return `
        <div class="hlc-row">
          <div class="hlc-label" style="color:${fg};background:${bg}">${esc(DECK_LABEL[k])}</div>
          <div class="hlc-track"><div class="hlc-fill" style="width:${pct}%;background:${bg}"></div></div>
          <div class="hlc-count">${n.toLocaleString()}</div>
        </div>`;
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
      return `
        <div class="hlc-row">
          <div class="hlc-label" style="color:${fg};background:${bg}">${esc(TIER_LABEL[tier])}</div>
          <div class="hlc-track"><div class="hlc-fill" style="width:${pct}%;background:${bg}"></div></div>
          <div class="hlc-count">${n.toLocaleString()}</div>
        </div>`;
    }).join('');
  }
  return `
    <div class="home-library-chart">
      <div class="hlc-header">
        <div class="hlc-title">${esc(copy.title)}</div>
        ${chipsHtml}
      </div>
      <div class="hlc-subtitle">${subtitle}</div>
      <div class="hlc-bars">${barsHtml}</div>
    </div>`;
}

const HLC_VIEW_KEY = 'pp:hlc-view';
const VALID_VIEWS = new Set(['library', 'wishlist', 'deck']);
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
  // 'deck' scopes to the library because the "how many of my games work
  // on Steam Deck" question is the common one. Wishlist can extend this
  // later if users ask.
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
