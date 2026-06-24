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
    expect(homeSrc).toContain('function _wirePillGroup(groupEl, onChange)');
    expect(homeSrc).toContain('function _readPillGroup(groupEl)');
    expect(homeSrc).toContain("allBtn.classList.remove('pg-filter--active')");
    expect(homeSrc).toContain("if (_readPillGroup(groupEl).size === 0 && allBtn) allBtn.classList.add('pg-filter--active')");
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
  test('text filter input has the short "Filter text" placeholder', () => {
    expect(homeSrc).toContain('id="home-text-filter"');
    expect(homeSrc).toContain('class="home-filter-text"');
    expect(homeSrc).toContain('placeholder="Filter text"');
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
    // Recent and Popular sections must both honor the text box.
    const matches = homeSrc.match(/_filterByText\(_filterByStore\([^]*?, textFilter\)/g) || [];
    expect(matches.length).toBe(2);
  });

  test('typing in the text box updates badge and re-renders both sections', () => {
    expect(homeSrc).toContain("document.getElementById('home-text-filter')?.addEventListener('input'");
    expect(homeSrc).toContain('textFilter = e.target.value');
  });

  test('text filter counts toward the active-filter badge when non-empty', () => {
    expect(homeSrc).toContain('storeSel.size + (textFilter.trim() ? 1 : 0)');
  });

  test('clear filters resets the text box value and textFilter state', () => {
    expect(homeSrc).toContain("if (textInput) textInput.value = ''");
    expect(homeSrc).toContain("textFilter = ''");
  });
});

describe('home page browse -- Save filters (persist)', () => {
  test('footer has a Save filters checkbox', () => {
    expect(homeSrc).toContain('id="home-filter-persist"');
    expect(homeSrc).toContain('Save filters');
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
    const firstApplyIdx = homeSrc.indexOf('applyRecentFilters();\n    applyPopularFilters();\n  } catch');
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
