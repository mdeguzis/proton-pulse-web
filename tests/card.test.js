/**
 * Behavioral tests for renderGameCard (js/app/lib/card.js): the rating pill
 * fallback ("No Rating"), the store pill, and box-art handling.
 *
 * card.js uses ?v=-suffixed imports, so load it through the vm helper (the same
 * approach storeHelpers.test.js uses for router.js) and inject its deps.
 */
const { loadEsm } = require('./_esm-vm.js');

function loadCard() {
  const ctx = loadEsm(['js/app/lib/card.js'], {
    STEAM_IMG: (id) => `https://img/${id}/header.jpg`,
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _loadSteamImg: () => {},
  });
  return ctx.renderGameCard;
}

describe('renderGameCard rating pill', () => {
  const renderGameCard = loadCard();

  test('a real tier renders an uppercase tier pill, not "No Rating"', () => {
    const html = renderGameCard({ href: '#/app/6020', appId: '6020', title: 'X', sub: '', tier: 'gold' });
    expect(html).toContain('>GOLD<');
    expect(html).not.toContain('No Rating');
  });

  test('no tier and no badge falls back to a muted "No Rating" pill', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '' });
    expect(html).toContain('game-card-badge--unrated');
    expect(html).toContain('>No Rating<');
  });

  test('an explicit badge (e.g. Pulse) is kept instead of "No Rating"', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', badge: 'Pulse' });
    expect(html).toContain('>Pulse<');
    expect(html).not.toContain('No Rating');
  });
});

describe('renderGameCard store tag', () => {
  const renderGameCard = loadCard();

  test('store renders as a corner tag overlaid on the artwork, not in the right column', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '', storePill: 'GOG' });
    expect(html).toContain('game-card-store-tag game-card-store-pill--gog');
    expect(html).toContain('>GOG<');
    // the tag lives inside the thumbnail wrapper, before the body
    expect(html.indexOf('game-card-store-tag')).toBeLessThan(html.indexOf('game-card-body'));
  });

  test('the right column holds only the rating pill (no store pill)', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '', storePill: 'GOG' });
    const right = html.slice(html.indexOf('game-card-right'));
    expect(right).not.toContain('game-card-store');
    expect(right).toContain('game-card-badge');
  });
});

describe('renderGameCard thumbnail', () => {
  const renderGameCard = loadCard();

  test('non-Steam ids still get an img with data-appid so the loader can resolve a cover', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '' });
    expect(html).toContain('data-appid="gog:1"');
    expect(html).toContain('onerror="window.__steamImgLoad(this)"');
  });
});
