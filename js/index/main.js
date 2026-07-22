// Entry module for index.html (homepage). Migrated from index.js.
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=2f0dee0e';
import { dataUrl } from '../lib/data-url.js?v=97f09986';
import { padTileRows, watchTileRerender, pageSizeForFullRows, targetRowsForViewport, currentColCount } from '../lib/tile-pad.js?v=ad4b114d';
import { filterAdult } from '../lib/adult-filter.js?v=e4e9d845';
import { renderGameCard } from '../app/lib/card.js?v=93448301';

// Homepage-only logic. Universal nav chrome (banner, nav row, mobile drawer,
// search dropdown, auth indicator) lives in topbar.js.

// Games-by-store snapshot. Counts entries in search-index.json by appType
// (column 5) and renders three numbers + a stacked bar showing the share
// each store contributes. Replaces the older 4-stat block; the deeper
// dashboard lives on stats.html.
(async function loadStoreCounts() {
  const root = document.getElementById('store-counts');
  if (!root) return;
  try {
    const resp = await fetch(await dataUrl('search-index.json'));
    if (!resp.ok) return;
    const rows = await resp.json();
    const counts = { steam: 0, gog: 0, epic: 0 };
    for (const row of rows) {
      const t = row[5];
      if (t === 'steam' || t === 'gog' || t === 'epic') counts[t]++;
    }
    const total = counts.steam + counts.gog + counts.epic;
    if (!total) return;
    document.getElementById('store-count-steam').textContent = counts.steam.toLocaleString();
    document.getElementById('store-count-gog').textContent   = counts.gog.toLocaleString();
    document.getElementById('store-count-epic').textContent  = counts.epic.toLocaleString();
    const bar = document.getElementById('store-count-bar');
    if (bar) {
      const pct = (n) => (n / total) * 100;
      bar.innerHTML = [
        `<div class="seg seg--steam" style="width:${pct(counts.steam)}%"></div>`,
        `<div class="seg seg--gog" style="width:${pct(counts.gog)}%"></div>`,
        `<div class="seg seg--epic" style="width:${pct(counts.epic)}%"></div>`,
      ].join('');
    }
    root.hidden = false;
  } catch (_) { /* leave the section hidden if anything goes wrong */ }
})();

// Popular games on Steam. Reads most_played.json (produced by the pipeline:
// Steam's most-played titles cross-referenced with our compat rating). Renders
// a wide-card list. The section stays hidden until data lands so it never shows
// empty on a fetch miss (older deploys / local dev without the file).
(async function loadPopularGames() {
  const list = document.getElementById('pg-list');
  const section = document.getElementById('popular-games');
  if (!list || !section) return;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  // 1275982 -> "1.3M", 732248 -> "732K", 940 -> "940"
  function fmtPeak(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n);
  }

  const KNOWN_TIERS = new Set(['platinum', 'gold', 'silver', 'bronze', 'borked']);
  const STORE_LABEL = { gog: 'GOG', epic: 'Epic', steam: 'Steam' };
  // #125: the storePill / storeTag / cornerTag / stripStoreHtml / comboTag /
  // storeColorClass helpers (and RATING_LABEL / STORE_PILL_CLASS) that used to
  // live here re-implemented what the shared renderGameCard already builds.
  // They are gone now; pgCardHtml delegates to renderGameCard so the homepage
  // grid and the app-page grid render identical markup and CSS.
  const SECTION_LABEL = { steam: 'Popular on Steam', gog: 'Popular GOG Games', epic: 'Popular Epic Games' };
  const SECTION_SUB = {
    steam: "Steam's most-played games and how they run on Linux through Proton.",
    gog: 'GOG catalog games and how they run on Linux.',
    epic: 'Epic Games Store titles and how they run on Linux.',
  };

  let currentLayout = 'grid';
  let storeSel = new Set(['steam']); // multi-select store filter; defaults to Steam
  let searchIndexCache = null;
  let steamPeakByTitle = new Map();
  // appId -> trend direction ('improving'|'declining'). Built once search-index
  // is available. Steam-only browse does not need the full index to render its
  // list, but the trend column lives there, so we lazy-fetch and re-render when
  // it lands (or, when already cached from a non-Steam filter, it's already in
  // hand and the arrows show on the first paint).
  let trendByAppId = new Map();

  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function _buildTrendMap() {
    trendByAppId = new Map();
    if (!Array.isArray(searchIndexCache)) return;
    for (const row of searchIndexCache) {
      if (!Array.isArray(row) || row.length < 10) continue;
      const t = row[9];
      if (t === 'improving' || t === 'declining') trendByAppId.set(String(row[0]), t);
    }
  }

  function _lookupTrend(appId) {
    if (appId == null) return '';
    return trendByAppId.get(String(appId)) || '';
  }

  async function loadSearchIndex() {
    if (searchIndexCache) return searchIndexCache;
    try {
      const resp = await fetch(await dataUrl('search-index.json'));
      if (resp.ok) {
        searchIndexCache = await resp.json();
        _buildTrendMap();
      }
    } catch (_) {}
    return searchIndexCache || [];
  }

  // #125: homepage cards render through the shared renderGameCard helper so the
  // homepage POPULAR grid and the app page grid stay identical. Peak players
  // goes into the standard sub string; renderGameCard emits the .game-card /
  // .game-card-strip markup that css/shared/cards.css styles, and the global
  // data-card-layout / data-store-pill-pos attributes (set by topbar.js on every
  // page) drive the strip bar and store pill exactly as on the app page.
  function pgCardHtml(g) {
    const rating = String(g.rating || '').toLowerCase();
    const rated = KNOWN_TIERS.has(rating);
    const peak = fmtPeak(g.peak);
    const sub = peak
      ? `<span class="game-card-sub-count">${peak}</span><span class="game-card-sub-suffix"> peak players</span>`
      : '';
    return renderGameCard({
      href: `app.html#/app/${encodeURIComponent(g.appId)}`,
      appId: g.appId,
      title: g.title,
      sub,
      tier: rated ? rating : undefined,
      storePill: STORE_LABEL[g.appType] || 'Steam',
      trend: _lookupTrend(g.appId),
    });
  }

  // The previous super-condensed pgListRowHtml is gone -- the two layouts
  // now are 'list' (horizontal cards from pgCardHtml) and 'grid' (the same
  // cards re-flowed into Steam-style vertical tiles by CSS).

  try {
    // Kick off search-index in parallel so trend arrows are ready on the very
    // first paint even when the user stays on Steam-only. loadSearchIndex
    // itself no-ops when the cache is already populated (e.g. from a
    // non-Steam filter earlier in the session).
    const [resp] = await Promise.all([
      fetch(await dataUrl('most_played.json')),
      loadSearchIndex(),
    ]);
    if (!resp.ok) {
      console.debug('[popular-games] most_played.json fetch not ok', { status: resp.status });
      return;
    }
    const games = await resp.json();
    if (!Array.isArray(games) || games.length === 0) {
      console.debug('[popular-games] most_played.json empty or not an array', { type: typeof games });
      return;
    }

    const ratedGames = games.filter((g) => KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
    const unratedGames = games.filter((g) => !KNOWN_TIERS.has(String(g.rating || '').toLowerCase()));
    steamPeakByTitle = new Map(games.map(g => [normTitle(g.title), g.peak || 0]));
    console.debug('[popular-games] loaded most_played.json', {
      total: games.length, rated: ratedGames.length, unrated: unratedGames.length, source: 'most_played.json',
    });

    section.hidden = false;

    const ratedBtn = document.getElementById('pg-filter-rated');
    const unratedBtn = document.getElementById('pg-filter-unrated');
    const ratedCountEl = document.getElementById('pg-rated-count');
    const unratedCountEl = document.getElementById('pg-unrated-count');
    const loadMoreEl = document.getElementById('pg-load-more');

    // Row target is 5 complete rows on every viewport (page size = cols * rows,
    // so the grid always ends on a whole row and stays even across S/M/L/XL).
    // See pageSizeForFullRows + targetRowsForViewport in lib/tile-pad.js.
    const state = { rated: true, unrated: false };
    let shownCount = pageSizeForFullRows(list, targetRowsForViewport());
    // Guards a one-shot re-render when the grid CSS hasn't applied yet on the
    // very first paint (see renderPopular). Without it the column count reads 1
    // and the page collapses to the 8-item floor (2 rows at 4 columns).
    let _popularColRetry = false;

    // Build the game list for the selected stores + rating filter state. Store
    // is multi-select: Steam pulls from most_played.json, GOG/Epic pull from the
    // search index filtered by appType (so catalog stubs with 0 reports show).
    // Results from all selected stores are merged and ranked together.
    function ratingPasses(rated) {
      // Both selected or neither selected -> show all; otherwise honor the one.
      if (state.rated && !state.unrated) return rated;
      if (state.unrated && !state.rated) return !rated;
      return true;
    }
    // An empty selection means "All" -> every store.
    function effectiveStores() {
      return storeSel.size === 0 ? ['steam', 'gog', 'epic'] : [...storeSel];
    }
    function currentList() {
      const stores = effectiveStores();
      const out = [];
      if (stores.includes('steam')) {
        if (state.rated || (!state.rated && !state.unrated)) out.push(...ratedGames);
        if (state.unrated || (!state.rated && !state.unrated)) out.push(...unratedGames);
      }
      const nonSteam = stores.filter(s => s !== 'steam');
      if (nonSteam.length) {
        const rows = (searchIndexCache || [])
          .filter(row => nonSteam.includes(row[5]))
          .filter(row => ratingPasses(KNOWN_TIERS.has(String(row[2] || '').toLowerCase())))
          .map(row => ({
            appId: row[0], title: row[1], rating: row[2] || '', appType: row[5],
            protondbCount: row[3] || 0, pulseCount: row[4] || 0,
          }));
        out.push(...rows);
      }
      // Rank the merged list: Steam peak-player rank first, then report count,
      // then alphabetical. Steam games carry peak directly; non-Steam borrow it
      // from a title match in the Steam most-played map.
      const peakOf = g => g.peak || steamPeakByTitle.get(normTitle(g.title)) || 0;
      const countOf = g => (g.protondbCount || 0) + (g.pulseCount || 0);
      return filterAdult(out).sort((a, b) =>
        peakOf(b) - peakOf(a) || countOf(b) - countOf(a) || (a.title || '').localeCompare(b.title || ''));
    }

    // Rated / Not Rated chip counts reflect the currently selected stores, not
    // just Steam. Steam counts come from most_played; GOG/Epic from the index.
    function updateRatingCounts() {
      const stores = effectiveStores();
      let rated = 0, unrated = 0;
      if (stores.includes('steam')) { rated += ratedGames.length; unrated += unratedGames.length; }
      const nonSteam = stores.filter(s => s !== 'steam');
      if (nonSteam.length && searchIndexCache) {
        for (const row of searchIndexCache) {
          if (!nonSteam.includes(row[5])) continue;
          if (KNOWN_TIERS.has(String(row[2] || '').toLowerCase())) rated++; else unrated++;
        }
      }
      if (ratedCountEl) ratedCountEl.textContent = String(rated);
      if (unratedCountEl) unratedCountEl.textContent = String(unrated);
      console.debug('[popular-games] rating counts updated', { stores, rated, unrated, source: nonSteam.length ? 'most_played+search-index' : 'most_played' });
    }

    function renderPopular() {
      const all = currentList();
      if (!all.length) {
        list.innerHTML = '<div class="pg-empty">No games match the current filters.</div>';
        if (loadMoreEl) loadMoreEl.innerHTML = '';
        return;
      }
      // Recompute the row-based target now that the grid layout should be
      // applied. The shared grid CSS (css/shared/cards.css) can still be
      // loading when the first render fires, so getComputedStyle reports the
      // container as display:flex and the column count reads 1, collapsing the
      // page to the 8-item floor (2 rows at 4 columns). When we intend to be in
      // grid mode but the columns have not resolved yet, defer one frame and
      // re-render so the initial page fills full rows. Retry once per pass so a
      // genuinely single-column viewport does not loop.
      const cols = currentColCount(list);
      const targetRows = targetRowsForViewport();
      if (currentLayout === 'grid' && cols < 2 && !_popularColRetry) {
        _popularColRetry = true;
        console.debug('[popular-games] grid columns not resolved yet, deferring a frame', { cols, currentLayout, reason: 'grid-css-not-applied', source: 'currentColCount' });
        requestAnimationFrame(renderPopular);
        return;
      }
      _popularColRetry = false;
      const target = pageSizeForFullRows(list, targetRows);
      if (shownCount < target) shownCount = target;
      const shown = Math.min(shownCount, all.length);
      console.debug('[popular-games] render rows', { cols, targetRows, target, shownCount, shown, total: all.length, layout: currentLayout });
      list.innerHTML = all.slice(0, shown).map(pgCardHtml).join('');
      const hasMore = all.length > shown;
      // In tile mode: when more items are queued, trim any orphan tiles on
      // the last row so the grid ends flush (the Load more button visually
      // fills the gap). When fully shown, pad the last row with invisible
      // fillers instead so the trailing tiles stay aligned.
      padTileRows(list, { tileSelector: '.game-card', hasMore });
      if (loadMoreEl) {
        // Recompute remaining after any orphan trim so the count is accurate.
        const rendered = list.querySelectorAll(':scope .game-card:not(.tile-filler)').length;
        const remaining = all.length - rendered;
        loadMoreEl.innerHTML = remaining > 0
          ? `<button class="pg-load-more" id="pg-load-more-btn" type="button">Load more <span class="pg-load-more-count">${remaining}</span></button>`
          : '';
        const moreBtn = document.getElementById('pg-load-more-btn');
        if (moreBtn) moreBtn.addEventListener('click', () => { shownCount = rendered + pageSizeForFullRows(list, targetRowsForViewport()); renderPopular(); });
      }
    }

    // Rated / Not Rated are independent toggles (multi-select). Both on or both
    // off both mean "show all", matching the browse page tier behavior.
    function syncRatingButtons() {
      ratedBtn?.classList.toggle('pg-filter--active', state.rated);
      unratedBtn?.classList.toggle('pg-filter--active', state.unrated);
      ratedBtn?.setAttribute('aria-pressed', String(state.rated));
      unratedBtn?.setAttribute('aria-pressed', String(state.unrated));
    }
    function toggleRating(key) {
      state[key] = !state[key];
      syncRatingButtons();
      shownCount = pageSizeForFullRows(list, targetRowsForViewport());
      updateFilterBadge();
      renderPopular();
    }
    ratedBtn?.addEventListener('click', () => toggleRating('rated'));
    unratedBtn?.addEventListener('click', () => toggleRating('unrated'));

    // Filters popover toggle.
    const filterWrap = document.getElementById('pg-filter-wrap');
    const filterToggle = document.getElementById('pg-filter-toggle');
    const filterPanel = document.getElementById('pg-filter-panel');
    if (filterToggle && filterPanel) {
      filterToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = filterPanel.classList.toggle('open');
        filterToggle.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', (e) => {
        // Panel gets portaled to <body> on mobile so it can rise above the
        // topbar's stacking context; allow taps inside the panel itself,
        // not just inside filterWrap, before treating this as outside-click.
        if (
          filterWrap
          && !filterWrap.contains(e.target)
          && !filterPanel.contains(e.target)
        ) {
          filterPanel.classList.remove('open');
          filterToggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    function updateFilterBadge() {
      const badge = document.getElementById('pg-filter-badge');
      const btn = document.getElementById('pg-filter-toggle');
      // Store deviates from the default (Steam only); rating deviates when it is
      // not the default "Rated only".
      const storeDev = (storeSel.size === 1 && storeSel.has('steam')) ? 0 : storeSel.size;
      const ratingDev = (state.unrated ? 1 : 0) + (state.rated ? 0 : 1);
      const nonDefault = storeDev + ratingDev;
      if (badge) { badge.textContent = String(nonDefault); badge.hidden = nonDefault === 0; }
      btn?.classList.toggle('has-filters', nonDefault > 0);
    }

    // Label/sub reflect a single selected store; multi-select shows a generic title.
    function syncSectionLabel() {
      const labelEl = document.getElementById('pg-section-label');
      const subEl = document.getElementById('pg-sub');
      const only = storeSel.size === 1 ? [...storeSel][0] : null;
      if (labelEl) labelEl.textContent = (only && SECTION_LABEL[only]) || 'Popular Games';
      if (subEl) subEl.textContent = (only && SECTION_SUB[only]) || '';
    }

    // Store filter is multi-select. Steam uses most_played; GOG/Epic lazy-load
    // the search index. Selecting any non-Steam store loads the index once.
    async function toggleStore(store) {
      // "All" clears the specific selections (empty set == all stores). Picking a
      // specific store clears All; deselecting the last specific falls back to All.
      if (store === 'all') {
        storeSel.clear();
      } else if (storeSel.has(store)) {
        storeSel.delete(store);
      } else {
        storeSel.add(store);
      }
      const allActive = storeSel.size === 0;
      document.querySelectorAll('.pg-store-btn').forEach(b => {
        const v = b.dataset.store;
        b.classList.toggle('pg-filter--active', v === 'all' ? allActive : storeSel.has(v));
      });
      syncSectionLabel();
      if (effectiveStores().some(s => s !== 'steam') && !searchIndexCache) {
        list.innerHTML = '<div class="pg-empty">Loading...</div>';
        await loadSearchIndex();
        console.debug('[popular-games] search-index loaded', { stores: effectiveStores(), entries: (searchIndexCache || []).length });
      }
      updateRatingCounts();
      updateFilterBadge();
      shownCount = pageSizeForFullRows(list, targetRowsForViewport());
      renderPopular();
    }
    document.querySelectorAll('.pg-store-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleStore(btn.dataset.store));
    });

    // S/M/L card size (saved preference, shared key with app page)
    const SIZE_KEY = 'pp:grid-size';
    const SIZES = ['sm', 'md', 'lg', 'xl'];
    // Default 'lg' on desktop so wider viewports get roomier cards by default;
    // mobile stays on 'md' to keep more rows on screen.
    const DEFAULT_SIZE = window.matchMedia('(min-width: 760px)').matches ? 'lg' : 'md';
    function savedSize() {
      try { const s = localStorage.getItem(SIZE_KEY); return SIZES.includes(s) ? s : DEFAULT_SIZE; } catch { return DEFAULT_SIZE; }
    }
    function applySize(size) {
      SIZES.forEach(s => list.classList.remove(`cards--${s}`));
      list.classList.add(`cards--${size}`);
      document.querySelectorAll('.pg-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === size));
      // The size class changes the column count, so the previously rendered
      // item count no longer fills whole rows -- the last row goes ragged and
      // the grid only looked even because of the initial full-rows render.
      // Refill to whole rows for the new width and re-render so S/M/L/XL each
      // land an even 5 rows without needing a page refresh.
      shownCount = pageSizeForFullRows(list, targetRowsForViewport());
      renderPopular();
    }
    function setSizeEnabled(enabled) {
      document.querySelectorAll('.pg-size-btn').forEach(b => { b.disabled = !enabled; });
      document.getElementById('pg-size-toggle')?.classList.toggle('pg-size-toggle--disabled', !enabled);
    }
    document.querySelectorAll('.pg-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(SIZE_KEY, btn.dataset.size); } catch { /* ignore */ }
        applySize(btn.dataset.size);
      });
    });

    // Layout: 'list' (horizontal cards, the new default) or 'grid'
    // (Steam-style vertical tile grid). Both layouts use the same card
    // markup; CSS reshapes them. Storage key is shared with the app page.
    const LAYOUT_KEY = 'pp:grid-layout';
    function savedLayout() {
      try { const l = localStorage.getItem(LAYOUT_KEY); return (l === 'list' || l === 'grid') ? l : 'grid'; } catch { return 'grid'; }
    }
    function applyLayout(layout) {
      currentLayout = layout;
      list.classList.toggle('home-cards-tile-mode', layout === 'grid');
      document.querySelectorAll('.pg-layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
      // S/M/L/XL sizing stays available in both layouts now -- it controls
      // tile column width in grid mode.
      setSizeEnabled(true);
      renderPopular();
      // Column count changes with viewport width, so a resize invalidates
      // the last-row clamp. watchTileRerender re-runs renderPopular on
      // debounced resize; it's idempotent so re-wiring on every layout
      // apply is safe.
      watchTileRerender(list, renderPopular);
    }
    document.querySelectorAll('.pg-layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(LAYOUT_KEY, btn.dataset.layout); } catch { /* ignore */ }
        applyLayout(btn.dataset.layout);
      });
    });

    updateRatingCounts(); // seed the rating chip counts for the default (Steam)
    applySize(savedSize());
    applyLayout(savedLayout());
  } catch (err) {
    console.debug('[popular-games] failed to load most_played.json', { error: String(err) });
    /* leave the section hidden */
  }
})();
