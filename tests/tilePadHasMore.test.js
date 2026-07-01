/**
 * Regression pin for tile-pad hasMore=true behavior.
 *
 * When the Popular / Recent grids have more items queued behind a Load
 * more button, an incomplete last row used to render with 2-3 orphan
 * tiles crammed against the left edge and blank space on the right (see
 * screenshot on index.html at ~1080px width, 12 items in a 5-col grid).
 *
 * The fix: pass hasMore=true to padTileRows, which trims the orphans so
 * the grid ends flush and the Load more button visually fills the gap.
 * The removed tiles come back via a re-render on the next click.
 *
 * The module uses live DOM APIs (getComputedStyle, createElement) so
 * behavioral coverage would need jsdom. Source-pin the wiring instead
 * so a regression on the flag path fails loudly.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TILEPAD  = fs.readFileSync(path.join(ROOT, 'js', 'lib', 'tile-pad.js'), 'utf8');
const INDEX    = fs.readFileSync(path.join(ROOT, 'js', 'index', 'main.js'), 'utf8');
const HOME     = fs.readFileSync(path.join(ROOT, 'js', 'app', 'components', 'home.js'), 'utf8');

describe('padTileRows(hasMore) trims orphans on incomplete last rows', () => {
  test('padTileRows accepts a hasMore option, default false', () => {
    expect(TILEPAD).toContain('hasMore = false');
  });

  test('hasMore=true branch removes the trailing orphans instead of padding', () => {
    // The trim loop reads the un-filtered items list, then removes the
    // last `remainder` of them so the grid ends on a full row.
    expect(TILEPAD).toMatch(/if \(hasMore\) \{/);
    expect(TILEPAD).toMatch(/orphan\.remove\(\)/);
  });

  test('hasMore=false still pads with .tile-filler divs (fully-shown case)', () => {
    expect(TILEPAD).toMatch(/fillerClass = 'tile-filler'/);
    expect(TILEPAD).toContain("f.className = fillerClass");
    expect(TILEPAD).toContain("f.setAttribute('aria-hidden', 'true')");
  });

  test('watchTileRerender exists so a resize triggers a fresh render (needed because trim is destructive)', () => {
    expect(TILEPAD).toContain('export function watchTileRerender(container, callback)');
    expect(TILEPAD).toContain("window.addEventListener('resize'");
  });
});

describe('renderers pass hasMore so incomplete rows never render', () => {
  test('index.html Popular grid passes hasMore based on the queue', () => {
    // renderPopular in js/index/main.js computes hasMore from all.length
    // vs shown, then hands it to padTileRows.
    expect(INDEX).toMatch(/const hasMore = all\.length > shown/);
    expect(INDEX).toMatch(/padTileRows\(list, \{ tileSelector: '\.pg-card', hasMore \}\)/);
  });

  test('home page Recent + Popular grids pass hasMore based on filtered vs shown', () => {
    // Both applyPopularFilters and applyRecentFilters compute the same
    // way and pass to padTileRows so orphans get trimmed identically.
    const popularPad = HOME.match(/padTileRows\(cardsEl, \{ tileSelector: '\.game-card', hasMore: filtered\.length > shown \}\)/g) || [];
    expect(popularPad.length).toBe(2);
  });

  test('load-more resets shown to the rendered count + PAGE_SIZE (not stale shownCount)', () => {
    // Because trim removes DOM nodes, the caller must read the actual
    // rendered count to know how many "extra" tiles the next click needs
    // to fetch. Both files use querySelectorAll(':scope ...:not(.tile-filler)')
    // to count real tiles.
    expect(INDEX).toContain(":not(.tile-filler)");
    expect(HOME).toContain(":not(.tile-filler)");
    expect(INDEX).toContain('rendered + PAGE_SIZE');
    expect(HOME).toContain('rendered + PAGE_SIZE');
  });

  test('resize wires renderPopular/Recent via watchTileRerender (not the old watchTileRows)', () => {
    // watchTileRows only re-runs padTileRows, which loses the trimmed
    // tiles on a viewport widening. watchTileRerender fires the caller's
    // render fn instead, which pulls fresh data.
    expect(INDEX).toContain('watchTileRerender(list, renderPopular)');
    expect(HOME).toContain('watchTileRerender(cardsEl, renderPopular)');
    expect(HOME).toContain('watchTileRerender(cardsEl, renderRecent)');
  });
});
