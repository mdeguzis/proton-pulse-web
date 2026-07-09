const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('configurable card size (S/M/L)', () => {
  const homeSrc = read('js/app/components/home.js');
  const cssSrc = read('css/app/home.css');

  test('renders an S/M/L size toggle', () => {
    expect(homeSrc).toContain('id="home-size-toggle"');
    expect(homeSrc).toContain('data-size="sm"');
    expect(homeSrc).toContain('data-size="md"');
    expect(homeSrc).toContain('data-size="lg"');
  });

  test('size is a saved user preference; default picks lg on desktop, md on mobile', () => {
    expect(homeSrc).toContain("const SIZE_KEY = 'pp:grid-size'");
    expect(homeSrc).toContain('localStorage.setItem(SIZE_KEY, size)');
    expect(homeSrc).toContain("window.matchMedia('(min-width: 760px)').matches ? 'lg' : 'md'");
    expect(homeSrc).toContain('SIZES.includes(s) ? s : _DEFAULT_SIZE');
    expect(homeSrc).toContain('applyGridSize(_savedSize())');
  });

  test('list/grid layout is also a saved preference, restored on load', () => {
    expect(homeSrc).toContain("const LAYOUT_KEY = 'pp:grid-layout'");
    expect(homeSrc).toContain('localStorage.setItem(LAYOUT_KEY, btn.dataset.layout)');
    expect(homeSrc).toContain('applyLayout(_savedLayout())');
  });

  test('size class is applied to both card lists', () => {
    expect(homeSrc).toContain("['cards-recent', 'cards-popular'].forEach");
    expect(homeSrc).toContain('el2.classList.add(`cards--${size}`)');
  });

  test('CSS defines the three card sizes', () => {
    expect(cssSrc).toContain('.cards--sm .game-card-thumb');
    expect(cssSrc).toContain('.cards--md .game-card-thumb');
    expect(cssSrc).toContain('.cards--lg .game-card-thumb');
  });

  test('S/M/L/XL stay enabled in both layouts (tile mode uses size as column width)', () => {
    expect(homeSrc).toContain('function _setSizeEnabled(enabled)');
    expect(homeSrc).toContain('b.disabled = !enabled');
    expect(homeSrc).toContain('_setSizeEnabled(true)');
    expect(cssSrc).toContain('.home-size-btn:disabled');
  });

  test('tile-mode (grid) applies to both Recent and Popular sections', () => {
    // applyLayout now grabs both section elements then toggles tile mode
    // on each via local references (recentEl / popularEl), so look for
    // the class swap on the popularEl variable.
    expect(homeSrc).toContain("popularEl?.classList.toggle('home-cards-tile-mode', isTile)");
    expect(homeSrc).toContain("recentEl?.classList.toggle('home-cards-tile-mode', isTile)");
    // both layouts use the same card renderer; CSS does the visual swap
    expect(homeSrc).toContain('function _popularItemHtml(g)');
    expect(homeSrc).not.toContain('_listRowHtml');
  });

  test('page-turner navigation re-renders the whole grid on each click', () => {
    // The windowed pagination model re-renders (rather than splice+append)
    // so the tile-row orphan trim on the last row stays correct after
    // every page change. The slice is [(page-1)*size, page*size].
    expect(homeSrc).toContain('windowRows.map(_recentCardHtml)');
    expect(homeSrc).toContain('windowRows.map(_popularItemHtml)');
    expect(homeSrc).toContain('filtered.slice(start, end)');
    expect(homeSrc).not.toContain('function _appendCards');
  });

  test('CSS reshapes the card container into a Steam-style tile grid', () => {
    expect(cssSrc).toContain('.home-cards-tile-mode');
    expect(cssSrc).toContain('grid-template-columns: repeat(auto-fill, minmax');
    expect(cssSrc).toContain('aspect-ratio: 460 / 215');
  });
});
