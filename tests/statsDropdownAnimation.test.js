// #417: the stats-page filter dropdowns must open/close by toggling .is-open on
// the persistent .filter-dropdown node, NOT by re-rendering the page. A full
// renderAll() recreates the node, so the shared clip-path drawer animation in
// css/shared/filters.css never gets a start state to transition from. This guards
// that the toggle stays a class flip. Source-level assertions match the pattern
// used in filterPanelRegressions / filterSessionCache.
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'stats', 'main.js'),
  'utf8',
);

describe('#417 stats dropdown open/close animates via a class toggle', () => {
  test('the toggle button handler calls setStatsDropdown, not renderAll', () => {
    const idx = mainSrc.indexOf("document.querySelectorAll('[data-dropdown-toggle]')");
    expect(idx).toBeGreaterThan(0);
    const slice = mainSrc.slice(idx, idx + 400);
    expect(slice).toContain('setStatsDropdown(');
    // A renderAll() here would recreate the node and kill the transition.
    expect(slice).not.toContain('renderAll()');
  });

  test('setStatsDropdown flips .is-open on the existing node instead of rebuilding', () => {
    expect(mainSrc).toMatch(/function\s+setStatsDropdown\s*\(dim\)/);
    expect(mainSrc).toMatch(/function\s+_applyDropdownOpenState\s*\(\)/);
    // The open state is applied by toggling the class on the persistent node.
    expect(mainSrc).toMatch(/classList\.toggle\('is-open',\s*on\)/);
  });

  test('outside-click close is managed by setStatsDropdown (animates the collapse)', () => {
    // The old code re-rendered on outside click; now it routes through
    // setStatsDropdown(null) so the collapse plays.
    expect(mainSrc).toMatch(/_statsDropdownCloser/);
    expect(mainSrc).toMatch(/setStatsDropdown\(null\)/);
  });
});
