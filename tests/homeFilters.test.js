const fs = require('fs');
const path = require('path');

const homeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8'
);

describe('home page browse filters (multi-select)', () => {
  test('tier group is checkboxes with All first, plus Rated and Not Rated Yet', () => {
    expect(homeSrc).toContain('id="home-tier-checks"');
    expect(homeSrc).toMatch(/value="all" checked><span>All<\/span>/);
    expect(homeSrc).toContain('value="rated"><span>Rated</span>');
    expect(homeSrc).toContain('value="unrated"><span>Not Rated Yet</span>');
    ['platinum', 'gold', 'silver', 'bronze', 'borked'].forEach(t => {
      expect(homeSrc).toContain(`value="${t}">`);
    });
  });

  test('source group is checkboxes with All first', () => {
    expect(homeSrc).toContain('id="home-source-checks"');
    expect(homeSrc).toContain('value="protondb"><span>ProtonDB</span>');
    expect(homeSrc).toContain('value="pulse"><span>Pulse</span>');
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

  test('checkbox group helper enforces All vs specific mutual exclusion', () => {
    expect(homeSrc).toContain('function _wireCheckGroup(groupEl, onChange)');
    expect(homeSrc).toContain('function _readCheckGroup(groupEl)');
    // checking All clears specifics; last specific unchecked re-checks All
    expect(homeSrc).toContain('if (cb.checked && allCb) allCb.checked = false');
    expect(homeSrc).toContain('if (_readCheckGroup(groupEl).size === 0 && allCb) allCb.checked = true');
  });

  test('filters drive both recent and popular lists via Sets', () => {
    expect(homeSrc).toContain('let tierSel = new Set()');
    expect(homeSrc).toContain('let sourceSel = new Set()');
    expect(homeSrc).toContain('_filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), tierSel), sourceSel)');
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
    expect(homeSrc).toContain("cb.checked = cb.value === 'all'");
  });
});
