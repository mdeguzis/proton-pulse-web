/**
 * Homepage card unification guard (#125).
 *
 * The homepage POPULAR grid must render through the shared renderGameCard
 * helper and reuse the shared .cards / .home-cards-tile-mode grid CSS, the same
 * as the app page. A previous attempt swapped the markup to renderGameCard but
 * left the grid styling behind on the old .pg-card classes, so the grid
 * collapsed. These assertions keep the JS renderer and the CSS it depends on
 * moving together.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const INDEX_JS = read('js/index/main.js');
const CARDS_CSS = read('css/shared/cards.css');
const INDEX_HTML = read('index.html');

describe('homepage cards use the shared renderer + shared grid CSS (#125)', () => {
  test('homepage imports and calls renderGameCard', () => {
    expect(INDEX_JS).toMatch(/import \{ renderGameCard \} from '\.\.\/app\/lib\/card\.js/);
    expect(INDEX_JS).toMatch(/return renderGameCard\(\{/);
  });

  test('homepage no longer hand-builds the bespoke pg-card markup', () => {
    // The old renderer emitted these literal class strings; renderGameCard
    // owns them now, so they must be gone from the homepage JS.
    expect(INDEX_JS).not.toMatch(/<a class="pg-card"/);
    expect(INDEX_JS).not.toMatch(/class="pg-card-strip"/);
  });

  test('homepage container toggles the shared grid classes, not pg-list--', () => {
    expect(INDEX_JS).toMatch(/classList\.add\(`cards--\$\{size\}`\)/);
    expect(INDEX_JS).toMatch(/classList\.toggle\('home-cards-tile-mode'/);
    expect(INDEX_JS).not.toMatch(/pg-list--\$\{size\}/);
    expect(INDEX_JS).not.toMatch(/'pg-list--tile-mode'/);
  });

  test('homepage container element uses the shared .cards class', () => {
    expect(INDEX_HTML).toMatch(/<div class="cards" id="pg-list">/);
  });

  test('shared cards.css carries the grid rules the homepage depends on', () => {
    // These must live in the shared stylesheet (loaded by index.html), not in
    // css/app/home.css (app page only), or the homepage grid has no styling.
    expect(CARDS_CSS).toMatch(/\.cards \{ display: flex/);
    expect(CARDS_CSS).toMatch(/\.cards--lg \.game-card-thumb/);
    expect(CARDS_CSS).toMatch(/\.home-cards-tile-mode \{/);
    expect(CARDS_CSS).toMatch(/\.home-cards-tile-mode \.game-card-thumb/);
  });
});
