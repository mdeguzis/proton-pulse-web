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

describe('renderGameCard trend arrow', () => {
  const renderGameCard = loadCard();

  test('trend "improving" renders the up-arrow span in the pills row', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', storePill: 'Steam', trend: 'improving' });
    expect(html).toContain('game-card-trend game-card-trend--improving');
    expect(html).toContain('Compatibility trending up');
    const pills = html.slice(html.indexOf('game-card-pills'));
    expect(pills).toContain('game-card-trend--improving');
  });

  test('trend "declining" renders the down-arrow span', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'bronze', trend: 'declining' });
    expect(html).toContain('game-card-trend game-card-trend--declining');
    expect(html).toContain('Compatibility trending down');
  });

  test('trend "stable" renders NO arrow (no glyph on unchanged games)', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', trend: 'stable' });
    expect(html).not.toContain('game-card-trend');
  });

  test('trend "insufficient" renders NO arrow', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', trend: 'insufficient' });
    expect(html).not.toContain('game-card-trend');
  });

  test('missing / undefined / empty trend renders NO arrow', () => {
    const noKey = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold' });
    const empty = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', trend: '' });
    const nully = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', trend: null });
    expect(noKey).not.toContain('game-card-trend');
    expect(empty).not.toContain('game-card-trend');
    expect(nully).not.toContain('game-card-trend');
  });

  test('trend arrow lives to the RIGHT of the store pill in pills row order', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', tier: 'gold', storePill: 'Steam', trend: 'improving' });
    const pillsStart = html.indexOf('game-card-pills');
    const pillsSlice = html.slice(pillsStart);
    const storeIdx = pillsSlice.indexOf('game-card-store-pill--steam');
    const trendIdx = pillsSlice.indexOf('game-card-trend');
    expect(storeIdx).toBeGreaterThan(-1);
    expect(trendIdx).toBeGreaterThan(storeIdx);
  });
});

describe('renderGameCard keeps type/demo markers OFF the tile (#251 follow-up)', () => {
  const renderGameCard = loadCard();

  test('game type renders no type or demo marker', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'X', sub: '', steamType: 'game' });
    expect(html).not.toContain('game-card-type-tag');
    expect(html).not.toContain('game-card-demo-stripe');
  });

  test('dlc type shows no tile marker (it moves to the detail page)', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'Some DLC', sub: '', steamType: 'dlc' });
    expect(html).not.toContain('game-card-type-tag');
    expect(html).not.toContain('>DLC<');
  });

  test('mod type shows no tile marker', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'A Mod', sub: '', steamType: 'mod' });
    expect(html).not.toContain('game-card-type-tag');
    expect(html).not.toContain('>MOD<');
  });

  test('software type shows no tile marker', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'Wallpaper Engine', sub: '', steamType: 'software' });
    expect(html).not.toContain('game-card-type-tag');
  });

  test('demo type no longer renders the diagonal stripe on the tile', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'Some App', sub: '', steamType: 'demo' });
    expect(html).not.toContain('game-card-demo-stripe');
    expect(html).not.toContain('game-card-type-tag');
  });

  test('title-based demo no longer renders a stripe on the tile', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'Portal Demo', sub: '' });
    expect(html).not.toContain('game-card-demo-stripe');
  });

  test('store pill still renders on the tile -- only the type markers were removed', () => {
    const html = renderGameCard({ href: '#/app/1', appId: '1', title: 'A Mod', sub: '', steamType: 'mod', storePill: 'Steam' });
    expect(html).toContain('game-card-thumb-wrap');
    expect(html).toContain('game-card-store-tag');
  });
});

// #431: library / wishlist icons ride along with the store banner in every
// placement so the user sees them next to the store icon whether the pill
// shows text + icon or icon-only. Because only ONE store-badge variant is
// visible at a time (per data-store-pill-pos), embedding the same owner
// badges in EACH variant guarantees they show up in the visible one without
// duplicating anywhere else on-screen.
describe('renderGameCard owner-badge placement (#431)', () => {
  const renderGameCard = loadCard();
  const OWNER_BADGES = '<span class="game-card-owner-badge">L</span>';

  test('owner badges are embedded inside .game-card-store-tag (art placement)', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      ownerBadges: OWNER_BADGES,
    });
    const m = html.match(/<span class="game-card-store-tag[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span class="game-card-replaced-tag/);
    // The store-tag span content up to its closing tag; use a coarser slice
    // in case the inner has no replaced-tag sibling.
    const tagBlock = html.match(/game-card-store-tag[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    expect(tagBlock).not.toBeNull();
    expect(tagBlock[1]).toContain('game-card-owner-badge');
  });

  test('owner badges are embedded inside .game-card-corner-tag (art-corner)', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      ownerBadges: OWNER_BADGES,
    });
    const m = html.match(/game-card-corner-tag[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('game-card-owner-badge');
  });

  test('owner badges are embedded inside .game-card-store-pill (right / bar-inline)', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      ownerBadges: OWNER_BADGES,
    });
    const m = html.match(/game-card-store-pill\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('game-card-owner-badge');
  });

  test('owner badges are embedded inside .game-card-strip-store (bar-segment)', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      ownerBadges: OWNER_BADGES,
    });
    const m = html.match(/game-card-strip-store[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('game-card-owner-badge');
  });

  test('owner badges are embedded inside .combo-store (combo layout)', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      tier: 'gold',
      ownerBadges: OWNER_BADGES,
    });
    const m = html.match(/<span class="combo-store">([\s\S]*?)<\/span>/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain('game-card-owner-badge');
  });

  test('no standalone .game-card-owner-corner element is emitted (design revised)', () => {
    // The earlier separate-corner approach is retired. Owner icons live
    // alongside the store banner so they follow the user's chosen placement.
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
      ownerBadges: OWNER_BADGES,
    });
    expect(html).not.toContain('game-card-owner-corner');
  });

  test('owner badges do not render at all when ownerBadges is empty', () => {
    const html = renderGameCard({
      href: '#/app/1', appId: '1', title: 'X', sub: '',
      storePill: 'Steam',
    });
    expect(html).not.toContain('game-card-owner-badge');
  });
});

describe('bar-inline store pill wraps the owner badge (CSS)', () => {
  // The markup already nests the owner badge inside .game-card-strip-store in
  // every placement; the bug was CSS. In bar-inline TEXT mode the brand pill
  // background used to sit on the .store-text child only, so the owner badge
  // (a sibling inside the transparent parent) rendered on the bare tier strip
  // to the left of the pill. The fix paints the whole .game-card-strip-store
  // span so the badge rides inside the colored pill like every other layout.
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css/shared/cards.css'), 'utf8');

  test('brand color is applied to the strip-store span, not just the store-text child', () => {
    // steam blue on the whole span in text mode (:not icon)
    expect(css).toMatch(/\[data-store-pill-pos="bar-inline"\]:not\(\[data-store-display="icon"\]\) \.game-card-strip\[data-store="steam"\] \.game-card-strip-store \{ background: #1689d0; \}/);
    // and the old child-only pill background is gone
    expect(css).not.toContain('.game-card-strip-store > .store-text { background: #1689d0; }');
  });

  test('the strip-store span itself carries the pill padding + radius in text mode', () => {
    const block = css.match(/\[data-store-pill-pos="bar-inline"\]:not\(\[data-store-display="icon"\]\) \.game-card-strip-store \{([\s\S]*?)\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toContain('border-radius: 999px');
    expect(block[1]).toContain('padding: 2px 8px');
  });
});
