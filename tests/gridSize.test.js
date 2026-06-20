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

  test('size is a saved user preference defaulting to medium', () => {
    expect(homeSrc).toContain("const SIZE_KEY = 'pp:grid-size'");
    expect(homeSrc).toContain('localStorage.setItem(SIZE_KEY, size)');
    expect(homeSrc).toContain("return SIZES.includes(s) ? s : 'md'");
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

  test('S/M/L are disabled in list mode', () => {
    expect(homeSrc).toContain('function _setSizeEnabled(enabled)');
    expect(homeSrc).toContain('b.disabled = !enabled');
    expect(homeSrc).toContain('_setSizeEnabled(!isList)');
    expect(cssSrc).toContain('.home-size-btn:disabled');
  });

  test('list view applies to both Recent and Popular sections', () => {
    expect(homeSrc).toContain("document.getElementById('cards-popular')?.classList.toggle('home-cards-list', isList)");
    // popular renders a slim list row in list mode, a sized card otherwise
    expect(homeSrc).toContain('function _popularItemHtml(g)');
    expect(homeSrc).toContain("if (currentLayout === 'list') return _listRowHtml(g)");
  });

  test('load more keeps the current view in both sections', () => {
    // recent appends with the layout-aware renderFn, popular with _popularItemHtml
    expect(homeSrc).toContain('batch.map(renderFn).join(\'\')');
    expect(homeSrc).toContain('batch.map(_popularItemHtml).join(\'\')');
    // the old layout-blind _appendCards helper is gone
    expect(homeSrc).not.toContain('function _appendCards');
  });
});
