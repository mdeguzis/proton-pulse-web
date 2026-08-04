const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('configurable card size (S/M/L)', () => {
  const homeSrc = read('js/app/components/home.js');
  const cssSrc = read('css/app/home.css');
  // #459 -- shared card-size helper. The SIZES / SIZE_KEY / DEFAULT_SIZE
  // constants + savedSize / applyCardSize / initCardSizeToggle helpers live
  // here so home + index consume one implementation instead of duplicating.
  const cardSizeSrc = read('js/lib/card-size.js');

  test('renders an S/M/L size toggle', () => {
    expect(homeSrc).toContain('id="home-size-toggle"');
    expect(homeSrc).toContain('data-size="sm"');
    expect(homeSrc).toContain('data-size="md"');
    expect(homeSrc).toContain('data-size="lg"');
  });

  test('size is a saved user preference; default picks lg on desktop, md on mobile', () => {
    // Constants + storage key live in the shared helper now.
    expect(cardSizeSrc).toContain("export const CARD_SIZE_KEY = 'pp:grid-size'");
    expect(cardSizeSrc).toContain("export const CARD_SIZES = ['sm', 'md', 'lg', 'xl']");
    expect(cardSizeSrc).toContain("window.matchMedia('(min-width: 760px)').matches ? 'lg' : 'md'");
    expect(cardSizeSrc).toContain('localStorage.setItem(CARD_SIZE_KEY');
    // Home consumes the helper -- no local duplicate.
    expect(homeSrc).toContain("import { initCardSizeToggle");
    expect(homeSrc).toContain('initCardSizeToggle({');
  });

  test('list/grid layout is also a saved preference, restored on load', () => {
    expect(homeSrc).toContain("const LAYOUT_KEY = 'pp:grid-layout'");
    expect(homeSrc).toContain('localStorage.setItem(LAYOUT_KEY, btn.dataset.layout)');
    expect(homeSrc).toContain('applyLayout(_savedLayout())');
  });

  test('size class is applied to both card lists', () => {
    // Home hands both card lists as containers into the shared apply pipeline;
    // the helper does the classList swap once per container.
    expect(homeSrc).toContain("document.getElementById('cards-recent')");
    expect(homeSrc).toContain("document.getElementById('cards-popular')");
    expect(cardSizeSrc).toContain('el.classList.add(`cards--${size}`)');
  });

  test('CSS defines the three card sizes', () => {
    expect(cssSrc).toContain('.cards--sm .game-card-thumb');
    expect(cssSrc).toContain('.cards--md .game-card-thumb');
    expect(cssSrc).toContain('.cards--lg .game-card-thumb');
  });

  test('S/M/L/XL stay enabled in both layouts (tile mode uses size as column width)', () => {
    // Home delegates the enable/disable to the shared setCardSizeButtonsEnabled
    // so the same logic can be reused by index and any future consumer.
    expect(homeSrc).toContain("import { initCardSizeToggle, setCardSizeButtonsEnabled }");
    expect(homeSrc).toContain('function _setSizeEnabled(enabled)');
    expect(homeSrc).toContain("setCardSizeButtonsEnabled(enabled, '.home-size-btn', 'home-size-toggle')");
    expect(homeSrc).toContain('_setSizeEnabled(true)');
    expect(cardSizeSrc).toContain('b.disabled = !enabled');
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
    // The visible-pages model re-renders (rather than splice+append) so
    // the tile-row orphan trim on the last row stays correct after every
    // page change. Each visible page is spliced out of `filtered` and
    // the results are concatenated so top-nav clicks reset to just that
    // page while Show More extends the set by one contiguous page (#253).
    expect(homeSrc).toContain('windowRows.map(_recentCardHtml)');
    expect(homeSrc).toContain('windowRows.map(_popularItemHtml)');
    expect(homeSrc).toContain('sortedPages.flatMap');
    expect(homeSrc).not.toContain('function _appendCards');
  });

  test('CSS reshapes the card container into a Steam-style tile grid', () => {
    expect(cssSrc).toContain('.home-cards-tile-mode');
    expect(cssSrc).toContain('grid-template-columns: repeat(auto-fill, minmax');
    expect(cssSrc).toContain('aspect-ratio: 460 / 215');
  });
});
