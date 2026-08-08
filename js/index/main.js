// Entry module for index.html (homepage). Migrated from index.js.
import { loadSteamImg as _loadSteamImg } from '../app/lib/steam-img.js?v=5adc7e54';
import { dataUrl } from '../lib/data-url.js?v=0de73aed';
import { padTileRows, watchTileRerender, pageSizeForFullRows, targetRowsForViewport, currentColCount } from '../lib/tile-pad.js?v=ad4b114d';
import { filterAdult } from '../lib/adult-filter.js?v=e4e9d845';
import { filterDelisted } from '../lib/delisted-filter.js?v=42858e22';
import { renderGameCard } from '../app/lib/card.js?v=db950b95';
import { browseGames, getGamesByIds } from '../app/api/search-games.js?v=0e14d3ff';
import { initCardSizeToggle, setCardSizeButtonsEnabled } from '../lib/card-size.js?v=3402f405';

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
    // #437: per-store totals via the browse API's exact count (limit 1, read
    // total) instead of scanning the full 11.8MB search-index.json blob.
    const [steam, gog, epic] = await Promise.all([
      browseGames({ store: 'steam', limit: 1 }),
      browseGames({ store: 'gog',   limit: 1 }),
      browseGames({ store: 'epic',  limit: 1 }),
    ]);
    const counts = { steam: steam.total || 0, gog: gog.total || 0, epic: epic.total || 0 };
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
  let steamPeakByTitle = new Map();
  // appId -> trend direction ('improving'|'declining'). #437: populated from
  // the search-games API -- a batch call for the Steam most-played ids, plus
  // whatever the non-Steam browse pages return -- instead of the full blob.
  let trendByAppId = new Map();
  // #437: shaped non-Steam rows for the stores the user has selected, fetched
  // via browseGames, plus per-store true totals for the rated/unrated chip
  // counts. Bounded because the landing grid only ever shows the top slice.
  const NONSTEAM_BROWSE_CAP = 500;
  let nonSteamRows = [];
  const nonSteamTotals = new Map();  // store -> true total (count=exact)
  const _nonSteamFetched = new Set(); // stores already pulled, to avoid refetch

  function normTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function _addTrend(appId, trend) {
    if (trend === 'improving' || trend === 'declining') trendByAppId.set(String(appId), trend);
  }

  function _lookupTrend(appId) {
    if (appId == null) return '';
    return trendByAppId.get(String(appId)) || '';
  }

  // Trend arrows for the Steam cards. Their appids are known from
  // most_played.json, so batch them (chunked by 500) rather than scanning the
  // whole index.
  async function _loadSteamTrend(appIds) {
    const ids = [...new Set(appIds.filter(Boolean).map(String))];
    for (let i = 0; i < ids.length; i += 500) {
      const byId = await getGamesByIds(ids.slice(i, i + 500));
      for (const r of byId.values()) _addTrend(r.appId, r.trend);
    }
  }

  // Fetch the top slice of each selected non-Steam store via browseGames (0-count
  // catalog games sort alphabetically, matching the old blob ordering), shaped
  // into the same row objects the grid used from the index. Records the true
  // per-store total for the chip counts and folds in any trend directions.
  async function _ensureNonSteamData(stores) {
    for (const store of stores.filter(s => s !== 'steam' && !_nonSteamFetched.has(s))) {
      let offset = 0;
      while (offset < NONSTEAM_BROWSE_CAP) {
        const { results, total } = await browseGames({ store, sort: 'popular', limit: 100, offset });
        nonSteamTotals.set(store, total);
        for (const r of results) {
          nonSteamRows.push({
            appId: r.appId, title: r.title, rating: r.tier || '', appType: r.source,
            protondbCount: r.protondbCount || 0, pulseCount: r.pulseCount || 0,
            delisted: r.delisted === true,
          });
          _addTrend(r.appId, r.trend);
        }
        offset += 100;
        if (results.length < 100) break;
      }
      _nonSteamFetched.add(store);
    }
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
    const resp = await fetch(await dataUrl('most_played.json'));
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

    // #437: trend arrows for the Steam cards via the batch API, and the
    // non-Steam slice if a non-Steam store is already selected. Awaited so the
    // first paint has arrows + counts, matching the old parallel-blob timing.
    await _loadSteamTrend(games.map(g => g.appId));
    await _ensureNonSteamData(effectiveStores());

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
        const rows = nonSteamRows
          .filter(r => nonSteam.includes(r.appType))
          .filter(r => ratingPasses(KNOWN_TIERS.has(String(r.rating || '').toLowerCase())));
        out.push(...rows);
      }
      // Rank the merged list: Steam peak-player rank first, then report count,
      // then alphabetical. Steam games carry peak directly; non-Steam borrow it
      // from a title match in the Steam most-played map.
      const peakOf = g => g.peak || steamPeakByTitle.get(normTitle(g.title)) || 0;
      const countOf = g => (g.protondbCount || 0) + (g.pulseCount || 0);
      return filterDelisted(filterAdult(out)).sort((a, b) =>
        peakOf(b) - peakOf(a) || countOf(b) - countOf(a) || (a.title || '').localeCompare(b.title || ''));
    }

    // Rated / Not Rated chip counts reflect the currently selected stores, not
    // just Steam. Steam counts come from most_played; GOG/Epic from the index.
    function updateRatingCounts() {
      const stores = effectiveStores();
      let rated = 0, unrated = 0;
      if (stores.includes('steam')) { rated += ratedGames.length; unrated += unratedGames.length; }
      // #437: non-Steam counts come from the browse true total per store. Rated
      // non-Steam games (report count > 0) sort first in the fetched slice, so
      // any that exist are already counted in nonSteamRows; the rest of the
      // store total is unrated.
      const nonSteam = stores.filter(s => s !== 'steam');
      for (const s of nonSteam) {
        const total = nonSteamTotals.get(s) || 0;
        const fetchedRated = nonSteamRows.filter(r => r.appType === s && KNOWN_TIERS.has(String(r.rating || '').toLowerCase())).length;
        rated += fetchedRated;
        unrated += Math.max(0, total - fetchedRated);
      }
      if (ratedCountEl) ratedCountEl.textContent = String(rated);
      if (unratedCountEl) unratedCountEl.textContent = String(unrated);
      console.debug('[popular-games] rating counts updated', { stores, rated, unrated, source: nonSteam.length ? 'most_played+browse-api' : 'most_played' });
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
      if (effectiveStores().some(s => s !== 'steam')) {
        list.innerHTML = '<div class="pg-empty">Loading...</div>';
        await _ensureNonSteamData(effectiveStores());
        console.debug('[popular-games] non-steam data loaded', { stores: effectiveStores(), rows: nonSteamRows.length });
      }
      updateRatingCounts();
      updateFilterBadge();
      shownCount = pageSizeForFullRows(list, targetRowsForViewport());
      renderPopular();
    }
    document.querySelectorAll('.pg-store-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleStore(btn.dataset.store));
    });

    // S/M/L/XL card size (saved preference, shared key with app page) via the
    // shared card-size helper. #459. The size class changes column count, so
    // onApply refills the visible grid to whole rows for the new width.
    const applySize = initCardSizeToggle({
      containers: [list],
      buttonSelector: '.pg-size-btn',
      onApply: () => {
        shownCount = pageSizeForFullRows(list, targetRowsForViewport());
        renderPopular();
      },
    });
    function setSizeEnabled(enabled) {
      setCardSizeButtonsEnabled(enabled, '.pg-size-btn', 'pg-size-toggle');
    }

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
    // initCardSizeToggle already applied the saved size on mount above.
    applyLayout(savedLayout());
  } catch (err) {
    console.debug('[popular-games] failed to load most_played.json', { error: String(err) });
    /* leave the section hidden */
  }
})();
