/**
 * Trend arrow site preference wiring.
 *
 * Options page renders a checkbox that persists to localStorage under
 * `pp:trend-arrow`. Topbar applies the attribute on every page before the
 * first paint so cards render correctly on the initial navigation. If any of
 * these plumbing bits go missing the toggle silently stops working.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const OPTIONS_HTML = read('options.html');
const OPTIONS_JS = read('js/options/main.js');
const TOPBAR_JS = read('js/lib/topbar.js');
const CARDS_CSS = read('css/shared/cards.css');

describe('trend arrow site pref', () => {
  test('options.html carries the checkbox with the expected id', () => {
    expect(OPTIONS_HTML).toContain('id="opt-trend-arrow"');
  });

  test('options main.js persists the toggle under pp:trend-arrow and defaults on', () => {
    expect(OPTIONS_JS).toContain("'pp:trend-arrow'");
    expect(OPTIONS_JS).toMatch(/const initial = stored !== 'off'/);
  });

  test('options main.js applies data-trend-arrow on toggle change', () => {
    expect(OPTIONS_JS).toMatch(/applyTrendArrow/);
    expect(OPTIONS_JS).toMatch(/setAttribute\('data-trend-arrow', 'off'\)/);
  });

  test('topbar.js applies the pref on every page before the first paint', () => {
    expect(TOPBAR_JS).toContain("localStorage.getItem('pp:trend-arrow')");
    expect(TOPBAR_JS).toMatch(/setAttribute\('data-trend-arrow', 'off'\)/);
  });

  test('cards.css hides .game-card-trend when data-trend-arrow="off"', () => {
    expect(CARDS_CSS).toMatch(/\[data-trend-arrow="off"\] \.game-card-trend \{ display: none/);
  });
});
