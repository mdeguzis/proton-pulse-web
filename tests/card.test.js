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

  test('store pill renders inside game-card-pills alongside the rating badge', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '', storePill: 'GOG' });
    expect(html).toContain('game-card-store-pill game-card-store-pill--gog');
    expect(html).toContain('>GOG<');
    // pill lives inside game-card-pills, which is inside game-card-right
    const pills = html.slice(html.indexOf('game-card-pills'));
    expect(pills).toContain('game-card-store-pill--gog');
    expect(pills).toContain('game-card-badge');
  });

  test('both overlay and right-column pill are rendered (CSS picks which is visible)', () => {
    const html = renderGameCard({ href: '#/app/gog:1', appId: 'gog:1', title: 'X', sub: '', storePill: 'GOG' });
    expect(html).toContain('game-card-store-tag game-card-store-pill--gog');
    expect(html).toContain('game-card-store-pill game-card-store-pill--gog');
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

describe('renderGameCard strip layout', () => {
  const renderGameCard = loadCard();

  test('renders both the right column and the strip element so CSS can pick one', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', storePill: 'Steam' });
    expect(html).toContain('game-card-right');
    expect(html).toContain('game-card-strip');
  });

  test('strip is a sibling of the row -- can span full card width', () => {
    // The bottom-bar layout needs the strip outside of game-card-body so it
    // can extend under the thumbnail. Verify the markup order: row, then strip.
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold' });
    const rowIdx = html.indexOf('game-card-row');
    const stripIdx = html.indexOf('game-card-strip');
    expect(rowIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeGreaterThan(rowIdx);
    // Strip should NOT be inside game-card-body
    const bodyOpen = html.indexOf('game-card-body');
    const bodyClose = html.indexOf('</div>', bodyOpen);
    expect(stripIdx).toBeGreaterThan(bodyClose);
  });

  test('strip carries data-tier so CSS can color the bar by tier', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold' });
    expect(html).toContain('data-tier="gold"');
    expect(html).toContain('game-card-strip-tier');
    expect(html).toContain('>GOLD<');
  });

  test('strip falls back to NO RATING when tier is missing', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '' });
    expect(html).toContain('data-tier=""');
    expect(html).toContain('>NO RATING<');
  });
});
