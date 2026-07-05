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
  test('text filter input placeholder makes clear it only filters the loaded list', () => {
    expect(homeSrc).toContain('id="home-text-filter"');
    expect(homeSrc).toContain('class="home-filter-text"');
    expect(homeSrc).toContain('placeholder="Filter loaded list"');
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
    // Recent and Popular sections must both honor the text box. The library
    // filter now sits between store and text so match _filterByLibrary too.
    const matches = homeSrc.match(/_filterByText\(_filterByLibrary\(_filterByStore\([^]*?, textFilter\)/g) || [];
    expect(matches.length).toBe(2);
  });

  test('typing in the text box updates badge and re-renders both sections', () => {
    expect(homeSrc).toContain("document.getElementById('home-text-filter')?.addEventListener('input'");
    expect(homeSrc).toContain('textFilter = e.target.value');
  });

  test('text filter counts toward the active-filter badge when non-empty', () => {
    expect(homeSrc).toContain('storeSel.size + librarySel.size + (textFilter.trim() ? 1 : 0)');
  });

  test('clear filters resets the text box value and textFilter state', () => {
    expect(homeSrc).toContain("if (textInput) textInput.value = ''");
    expect(homeSrc).toContain("textFilter = ''");
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

describe('home page browse -- page size targets full rows', () => {
  test('initial + Load more sizes come from pageSizeForFullRows(cardsEl, 4)', () => {
    // Replaces the older fixed pp:load-count preference (50/100/150/200)
    // with a row-count target so the grid always shows ~4 complete rows
    // regardless of viewport (mobile drops to the 8-item floor). See
    // pageSizeForFullRows in js/lib/tile-pad.js.
    // Row target is now viewport-aware (5 mobile / 4 desktop) via
    // targetRowsForViewport() in lib/tile-pad.js.
    expect(homeSrc).toContain('pageSizeForFullRows(cardsEl, targetRowsForViewport())');
    // Old fixed preload count is no longer wired to paging (kept in
    // localStorage for backwards compat, but not read by the render).
    expect(homeSrc).not.toContain('const PAGE_SIZE = _loadCount();');
  });
});

describe('home page browse -- loaded count display', () => {
  test('both section headers have a count element', () => {
    expect(homeSrc).toContain('id="recent-count"');
    expect(homeSrc).toContain('id="popular-count"');
  });

  test('_updateShownCount shows loaded vs total and refreshes on load-more', () => {
    expect(homeSrc).toContain('function _updateShownCount(countId, cardsEl, total)');
    expect(homeSrc).toContain('`${cardsEl.children.length} of ${total} loaded`');
    // called for both sections on render and on load-more append
    const recent = homeSrc.match(/_updateShownCount\('recent-count'/g) || [];
    const popular = homeSrc.match(/_updateShownCount\('popular-count'/g) || [];
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(popular.length).toBeGreaterThanOrEqual(2);
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
