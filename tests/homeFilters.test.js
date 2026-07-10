const fs = require('fs');
const path = require('path');

const homeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8'
);

describe('home page browse filters (multi-select)', () => {
  test('tier group is pill buttons with All first, plus Rated and Not Rated Yet', () => {
    expect(homeSrc).toContain('id="home-tier-checks"');
    expect(homeSrc).toContain('class="pg-filter pg-filter--active" type="button" data-value="all"');
    expect(homeSrc).toContain('data-value="rated"');
    expect(homeSrc).toContain('data-value="unrated"');
    ['platinum', 'gold', 'silver', 'bronze', 'borked'].forEach(t => {
      expect(homeSrc).toContain(`data-value="${t}"`);
    });
  });

  test('source group is pill buttons with All first', () => {
    expect(homeSrc).toContain('id="home-source-checks"');
    expect(homeSrc).toContain('data-value="protondb"');
    expect(homeSrc).toContain('data-value="pulse"');
  });

  test('filters live in a popover toggled by a Filters button', () => {
    expect(homeSrc).toContain('id="home-filter-toggle"');
    expect(homeSrc).toContain('id="home-filter-panel"');
    expect(homeSrc).toContain("filterPanel.classList.toggle('open')");
  });

  test('_filterByTier is Set-based and handles rated / unrated / specific tiers', () => {
    expect(homeSrc).toContain('function _filterByTier(reports, sel)');
    expect(homeSrc).toContain("if (!sel || sel.size === 0 || sel.has('all')) return reports");
    expect(homeSrc).toContain("if (v === 'rated' && isRated) return true");
    expect(homeSrc).toContain("if (v === 'unrated' && !isRated) return true");
  });

  test('_filterByType is Set-based across protondb / pulse', () => {
    expect(homeSrc).toContain('function _filterByType(reports, sel)');
    expect(homeSrc).toContain("if (v === 'protondb' && (r.protondbCount || 0) > 0) return true");
    expect(homeSrc).toContain("if (v === 'pulse' && (r.pulseCount || 0) > 0) return true");
  });

  test('pill group helper enforces All vs specific mutual exclusion', () => {
    // #96: the wire/read pair moved to js/app/lib/filter-group.js. home.js
    // imports them; the mutual-exclusion rules live in the shared helper.
    expect(homeSrc).toMatch(/from '\.\.\/lib\/filter-group\.js/);
    const filterGroupSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'js', 'app', 'lib', 'filter-group.js'),
      'utf8',
    );
    expect(filterGroupSrc).toContain('export function wireGroup(');
    expect(filterGroupSrc).toContain('export function readActive(');
    expect(filterGroupSrc).toContain("btn.dataset.value === 'all'");
    expect(filterGroupSrc).toMatch(/if \(readActive\([\s\S]*\)\.size === 0 && allBtn\)/);
  });

  test('filters drive both recent and popular lists via Sets', () => {
    expect(homeSrc).toContain('let tierSel = new Set()');
    expect(homeSrc).toContain('let sourceSel = new Set()');
    expect(homeSrc).toContain('_filterByStore(_filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), tierSel), sourceSel), storeSel)');
  });

  test('Not Rated Yet surfaces unrated catalog games in the popular section', () => {
    expect(homeSrc).toContain("const wantUnrated = tierSel.has('all') || tierSel.has('unrated')");
    expect(homeSrc).toContain('...(wantUnrated ? unratedGames : [])');
    // legacy separate unrated toggle is gone
    expect(homeSrc).not.toContain("id=\"unrated-toggle\"");
    expect(homeSrc).not.toContain('showingUnrated');
  });

  test('a Clear filters button resets groups and selections', () => {
    expect(homeSrc).toContain('id="home-filter-clear"');
    expect(homeSrc).toContain('tierSel = new Set();');
    expect(homeSrc).toContain('sourceSel = new Set();');
    expect(homeSrc).toContain('storeSel = new Set();');
    expect(homeSrc).toContain("g.querySelectorAll('.pg-filter').forEach(b => b.classList.remove('pg-filter--active'))");
    expect(homeSrc).toContain("allBtn.classList.add('pg-filter--active')");
  });
});

describe('home page popular section -- store-aware label and pool', () => {
  test('popular section label element has an id for dynamic updates', () => {
    expect(homeSrc).toContain('id="popular-section-label"');
  });

  test('_popularSectionLabel returns correct label per store selection', () => {
    expect(homeSrc).toContain('function _popularSectionLabel(sel)');
    expect(homeSrc).toContain("return 'Popular on Steam'");
    expect(homeSrc).toContain("return 'Popular GOG Games'");
    expect(homeSrc).toContain("return 'Popular Epic Games'");
    expect(homeSrc).toContain("return 'Popular Games'");
  });

  test('applyPopularFilters updates the label element text', () => {
    expect(homeSrc).toContain('labelEl.textContent = _popularSectionLabel(storeSel)');
  });

  test('non-Steam-only store selection pulls from searchIndex stubs', () => {
    expect(homeSrc).toContain("const wantNonSteamOnly = storeSel.size > 0 && !storeSel.has('all') && !storeSel.has('steam')");
    expect(homeSrc).toContain('(searchIndex || [])');
    expect(homeSrc).toContain('.filter(row => row[5] && storeSel.has(row[5]))');
  });

  test('Steam/all path still uses wantUnrated and unratedGames for tier compat', () => {
    expect(homeSrc).toContain("const wantUnrated = tierSel.has('all') || tierSel.has('unrated')");
    expect(homeSrc).toContain('...(wantUnrated ? unratedGames : [])');
  });
});

describe('home page browse -- text filter box', () => {
  test('text filter input placeholder makes clear it searches all titles', () => {
    // Previous placeholder "Filter loaded list" sold the box short --
    // with windowed pagination every title is in the filterable set, so
    // typing narrows across every page not just the visible one.
    expect(homeSrc).toContain('id="home-text-filter"');
    expect(homeSrc).toContain('class="home-filter-text"');
    expect(homeSrc).toContain('placeholder="Search all titles"');
  });

  test('text box lives in the bar (home-filter-left), outside the filter panel', () => {
    expect(homeSrc).toContain('<div class="home-filter-left">');
    // The input must come AFTER the filter panel closes, not inside it.
    const panelIdx = homeSrc.indexOf('id="home-filter-panel"');
    const inputIdx = homeSrc.indexOf('id="home-text-filter"');
    const footerIdx = homeSrc.indexOf('filter-panel-footer--stack');
    expect(inputIdx).toBeGreaterThan(panelIdx);
    expect(inputIdx).toBeGreaterThan(footerIdx);
  });

  test('_filterByText is a case-insensitive, trimmed title substring match', () => {
    expect(homeSrc).toContain('function _filterByText(reports, text)');
    expect(homeSrc).toContain("const q = String(text || '').trim().toLowerCase()");
    expect(homeSrc).toContain('if (!q) return reports');
    expect(homeSrc).toContain("return reports.filter(r => String(r.title || '').toLowerCase().includes(q))");
  });

  test('both filter pipelines pass results through _filterByText with textFilter', () => {
    // Recent and Popular sections must both honor the text box. Both chains
    // end in `..., textFilter)`. The intermediate filters are exercised in
    // dedicated deck/wishlist/library tests -- here we just pin the outer
    // shape (text is outermost, and inside it kind wraps the trio).
    const matches = homeSrc.match(/_filterByText\(_filterByKind\(_filterByDeck\([^]*?, textFilter\)/g) || [];
    expect(matches.length).toBe(2);
  });

  test('typing in either the bar input or the mobile-panel input updates state', () => {
    // Bar input (desktop) and panel input (mobile) share a single onInput
    // handler; both ids must appear in the wiring array.
    expect(homeSrc).toContain("['home-text-filter', 'home-text-filter-mobile']");
    expect(homeSrc).toContain('inp.addEventListener');
    expect(homeSrc).toContain('textFilter = val');
  });

  test('text filter counts toward the active-filter badge when non-empty', () => {
    // The badge count sums every filter set + a 1 for a non-empty text
    // query. Wishlist (#266 Phase 1) + Deck (#266 Phase 2) both slot in
    // ahead of kind. Pin the outer shape rather than the exact chain.
    expect(homeSrc).toContain('deckSel.size + kindSel.size + (textFilter.trim() ? 1 : 0)');
  });

  test('clear filters resets BOTH the desktop and mobile inputs', () => {
    // The clear path must walk both input ids so the panel copy also empties.
    const clearBlock = homeSrc.slice(homeSrc.indexOf('home-filter-clear'));
    expect(clearBlock).toContain("['home-text-filter', 'home-text-filter-mobile']");
    expect(homeSrc).toContain("textFilter = ''");
  });

  test('mobile panel exposes a duplicate text input inside the filter panel', () => {
    // Regression guard for the mobile filter collision fix: the mobile copy
    // must live inside the filter panel so it toggles with the FILTERS button
    // (avoiding the S/M/L layout row overlap seen at ~<720px).
    const panelStart = homeSrc.indexOf('id="home-filter-panel"');
    const mobileInputIdx = homeSrc.indexOf('id="home-text-filter-mobile"');
    const footerIdx = homeSrc.indexOf('filter-panel-footer--stack');
    expect(mobileInputIdx).toBeGreaterThan(panelStart);
    expect(mobileInputIdx).toBeLessThan(footerIdx);
    expect(homeSrc).toContain('filter-item--mobile-only');
  });
});

describe('home page browse -- Save filters (persist)', () => {
  test('Save filters is a rounded toggle button (not a checkbox)', () => {
    expect(homeSrc).toContain('class="filter-save-btn" id="home-filter-persist"');
    expect(homeSrc).toContain('Save filters');
    expect(homeSrc).not.toContain('type="checkbox" id="home-filter-persist"');
    // toggle state tracked via aria-pressed + is-active class
    expect(homeSrc).toContain("btn.setAttribute('aria-pressed', String(on))");
    expect(homeSrc).toContain("btn.classList.toggle('is-active', on)");
  });

  test('saves the full filter state to localStorage under a stable key', () => {
    expect(homeSrc).toContain("const FILTERS_KEY = 'pp:browse-filters'");
    expect(homeSrc).toContain('localStorage.setItem(FILTERS_KEY, JSON.stringify(');
    expect(homeSrc).toContain('tier: [...tierSel], source: [...sourceSel], store: [...storeSel]');
  });

  test('only writes when the box is checked', () => {
    expect(homeSrc).toContain('function _saveFiltersIfEnabled() { if (_persistOn()) _saveFilters(); }');
  });

  test('unchecking the box removes the saved state', () => {
    expect(homeSrc).toContain('localStorage.removeItem(FILTERS_KEY)');
  });

  test('restores a saved filter set before the first render', () => {
    expect(homeSrc).toContain('function _restoreFilters()');
    expect(homeSrc).toContain('storeSel = new Set(saved.store || [])');
    const restoreIdx = homeSrc.indexOf('_restoreFilters(); // re-apply');
    // The renderHomeLibraryChart call was added between applyPopularFilters()
    // and the catch, so match the pair of Apply calls that comes right after
    // _restoreFilters. (#199)
    const firstApplyIdx = homeSrc.indexOf('applyRecentFilters();\n    applyPopularFilters();\n\n    // Signed-in library');
    expect(restoreIdx).toBeGreaterThan(0);
    expect(restoreIdx).toBeLessThan(firstApplyIdx);
  });

  test('every filter change calls _saveFiltersIfEnabled', () => {
    // sort, text, three pill groups, and clear = 6 call sites.
    const matches = homeSrc.match(/_saveFiltersIfEnabled\(\)/g) || [];
    // 1 definition + at least 6 call sites.
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });
});

describe('home page browse -- page size comes from user pref (#253)', () => {
  test('page size is read from getEffectivePageSize, not fixed row targets', () => {
    // Replaces the older fixed pp:load-count preference and the row-count
    // target (pageSizeForFullRows) with a user-facing tiles-per-page pref
    // that defaults per viewport (mobile 20, desktop 50) and can be
    // overridden on the Site Options page. See js/lib/pagination-prefs.js.
    expect(homeSrc).toContain('getEffectivePageSize()');
    expect(homeSrc).not.toContain('const PAGE_SIZE = _loadCount();');
  });
});

describe('home page browse -- loaded count display', () => {
  test('both section headers have a count element', () => {
    expect(homeSrc).toContain('id="recent-count"');
    expect(homeSrc).toContain('id="popular-count"');
  });

  test('_updateShownCount shows loaded vs total next to the section label', () => {
    expect(homeSrc).toContain('function _updateShownCount(countId, cardsEl, total)');
    // The single count next to the section label is the only place the
    // total shows up now -- the extra "Showing N/N games" strip was
    // dropped because it duplicated the same fact right below it.
    expect(homeSrc).toContain('`${loaded} of ${total}`');
    // Reads real tiles (skipping fillers) so the count matches what a
    // reader can actually see and click.
    expect(homeSrc).toContain(":not(.tile-filler)");
    const recent = homeSrc.match(/_updateShownCount\('recent-count'/g) || [];
    const popular = homeSrc.match(/_updateShownCount\('popular-count'/g) || [];
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(popular.length).toBeGreaterThanOrEqual(2);
  });

  test('no separate "Showing" strip element or state', () => {
    // Trying to keep two counters in sync gave contradictory totals
    // (recent had library-owned rows, popular had different data). The
    // section-count next to the label is the single source of truth now.
    expect(homeSrc).not.toContain('home-result-count');
    expect(homeSrc).not.toContain('_refreshResultCountStrip');
    expect(homeSrc).not.toContain('_sectionCounts');
  });
});

describe('home page browse -- visible-pages pagination (#253)', () => {
  test('renderRecent tracks a set of visible pages and slices each one', () => {
    // The append model: visibleRecentPages is the Set of contiguous page
    // numbers currently rendered. Top nav click resets it to {N}; the
    // Show More button below the grid extends it by one. flatMap over
    // the sorted set builds windowRows so the visible tiles keep their
    // natural page-order.
    expect(homeSrc).toContain('let visibleRecentPages = new Set([1]);');
    expect(homeSrc).toContain('sortedPages.flatMap');
    expect(homeSrc).not.toContain("_loadMoreBtn('recent')");
  });

  test('renderPopular tracks its own visible-pages set too', () => {
    expect(homeSrc).toContain('let visiblePopularPages = new Set([1]);');
    expect(homeSrc).not.toContain("_loadMoreBtn('popular')");
  });

  test('top nav click resets visible-pages to just the chosen page', () => {
    // Explicit reset: clicking page N replaces the whole visible set
    // with {N} so any Show More expansion below is dropped. This is the
    // "click a page link, view resets to that page" behavior.
    expect(homeSrc).toContain('visibleRecentPages = new Set([n]);');
    expect(homeSrc).toContain('visiblePopularPages = new Set([n]);');
  });

  test('Show More button appends the next contiguous page', () => {
    // The bottom slot (page-nav-*-bottom) is now the Show More entry
    // point instead of a mirrored numbered nav. Clicking it adds
    // lastPage + 1 to the visible set.
    expect(homeSrc).toContain('id="page-nav-recent-bottom"');
    expect(homeSrc).toContain('id="page-nav-popular-bottom"');
    expect(homeSrc).toContain('_renderShowMore');
    expect(homeSrc).toContain('visibleRecentPages.add(lastPage + 1)');
    expect(homeSrc).toContain('visiblePopularPages.add(lastPage + 1)');
  });

  test('top nav click scrolls the section back into view', () => {
    // The reset drops appended pages, so the previous scroll position may
    // be well past the section header. Scrolling back keeps the user
    // oriented instead of stranded halfway down the old view.
    expect(homeSrc).toContain("_scrollToSection('recent-section')");
    expect(homeSrc).toContain("_scrollToSection('popular-section')");
  });
});

describe('home page browse -- text filter searches all titles', () => {
  test('text filter runs before pagination, not against a page slice', () => {
    // _filterByText receives the full sorted+filtered array; the caller
    // then slices for the current page. So typing "cyber" narrows the
    // 714-row dataset to matching titles across every page, not just the
    // 50 visible tiles.
    // Chain shape: text is applied AFTER kind, and kind is applied AFTER the
    // deck/wishlist/library trio -- the exact intermediate filters between
    // kind and library keep growing (#266 added Wishlist + Deck), so we
    // pin the two edges instead of the whole chain.
    expect(homeSrc).toMatch(/_filterByText\(_filterByKind\(_filterByDeck\(/);
    expect(homeSrc).toMatch(/_filterByWishlist\(_filterByLibrary\(/);
    // Placeholder wording matches the actual behavior (previous text
    // "Filter loaded list" implied only visible items).
    expect(homeSrc).toContain('placeholder="Search all titles"');
  });
});

describe('home page browse -- Type filter (#250)', () => {
  test('Type filter chip group is rendered in the filter panel', () => {
    // The panel is markup inside home.js so a source-level check is
    // enough here; a full DOM assertion lives in the smoke test.
    expect(homeSrc).toContain('id="home-kind-checks"');
    expect(homeSrc).toContain('<span class="pg-filter-group-label">Type</span>');
    // Standard Steam appdetails type buckets we surface as filters.
    expect(homeSrc).toContain('data-value="game"');
    expect(homeSrc).toContain('data-value="dlc"');
    expect(homeSrc).toContain('data-value="mod"');
    expect(homeSrc).toContain('data-value="demo"');
    expect(homeSrc).toContain('data-value="software"');
  });

  test('_filterByKind drops non-matching Steam entries, lets non-Steam pass', () => {
    // Steam entries with a `type` come through the search-index column
    // 11 lookup. Non-Steam ids (gog:*, epic:*) always pass -- the
    // pipeline does not enrich them with a Steam-side type.
    expect(homeSrc).toContain('function _filterByKind(reports, sel)');
    expect(homeSrc).toContain("if (!/^\\d+$/.test(id)) return true;");
    // Missing entries fall back to 'game' so payloads that predate the
    // enrichment stay visible when a specific kind chip is selected.
    expect(homeSrc).toContain("_lookupSteamType(id) || 'game'");
  });

  test('Type filter runs inside both applyRecentFilters and applyPopularFilters', () => {
    // _filterByKind wraps whatever the innermost filter of the chain is.
    // Both filter chains (recent + popular) call it, so we expect two
    // occurrences. Pinning to `_filterByKind\(_filterByDeck` since #266
    // Phase 2 slotted deck between kind and wishlist.
    const inRecent  = homeSrc.match(/_filterByKind\(_filterByDeck/g) || [];
    expect(inRecent.length).toBeGreaterThanOrEqual(2);
  });

  test('kindSel state is added to save/restore and clear-filters flows', () => {
    expect(homeSrc).toContain('let kindSel = new Set();');
    expect(homeSrc).toContain('kind: [...kindSel]');
    expect(homeSrc).toContain('kindSel = new Set(saved.kind || []);');
    expect(homeSrc).toContain('kindSel = new Set();');
  });
});

describe('home page browse -- sort options', () => {
  test('sort select carries A-Z and Z-A options', () => {
    expect(homeSrc).toContain('<option value="alpha">A-Z (Title)</option>');
    expect(homeSrc).toContain('<option value="alpha_desc">Z-A (Title)</option>');
  });

  test('_sortReports handles alpha and alpha_desc', () => {
    expect(homeSrc).toContain("sort === 'alpha'");
    expect(homeSrc).toContain("sort === 'alpha_desc'");
    // Uses localeCompare with base sensitivity so Á == A and ordering is
    // predictable across accented characters.
    expect(homeSrc).toContain("sensitivity: 'base'");
  });
});

describe('home page browse -- unrated cards show "No Rating", never "PENDING"', () => {
  test('_cardTier only returns a known rated tier, otherwise undefined', () => {
    expect(homeSrc).toContain('function _cardTier(t)');
    expect(homeSrc).toContain('return KNOWN_TIERS.has(x) ? x : undefined;');
  });

  test('card renders pass tier through _cardTier so pending becomes No Rating', () => {
    // Neither card builder should pass a raw tier string straight through.
    expect(homeSrc).toContain('tier: _cardTier(r.tier),');
    expect(homeSrc).toContain('tier: _cardTier(g.tier),');
    expect(homeSrc).not.toContain('tier: g.tier || undefined');
  });
});
