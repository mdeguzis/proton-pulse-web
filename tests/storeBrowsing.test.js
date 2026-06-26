/**
 * Tests for the store pill + store filter feature across the browse/search UI.
 * Behavioral coverage for the _filterByStore guard, plus source-level checks for
 * the DOM wiring that the vm harness can't exercise (mirrors homeFilters.test.js).
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const homeSrc = read('js/app/components/home.js');
const cardSrc = read('js/app/lib/card.js');
const searchSrc = read('js/app/components/search.js');
const cardsCss = read('css/shared/cards.css');

describe('_filterByStore (behavioral)', () => {
  // Provide the appTypeFromAppId dependency the function falls back to.
  const ctx = loadEsm(['js/app/components/home.js'], {
    appTypeFromAppId: (id) => {
      const s = String(id);
      if (s.startsWith('gog:')) return 'gog';
      if (s.startsWith('epic:')) return 'epic';
      return 'steam';
    },
  });
  const { _filterByStore } = ctx;
  const reports = [
    { appId: '6020', appType: 'steam' },
    { appId: 'gog:111' },                 // appType derived from id prefix
    { appId: 'epic:abc', appType: 'epic' },
  ];

  test('empty set returns everything (no filtering)', () => {
    expect(_filterByStore(reports, new Set())).toHaveLength(3);
  });
  test('"all" returns everything', () => {
    expect(_filterByStore(reports, new Set(['all']))).toHaveLength(3);
  });
  test('filters to a single store', () => {
    const gog = _filterByStore(reports, new Set(['gog']));
    expect(gog).toHaveLength(1);
    expect(gog[0].appId).toBe('gog:111');
  });
  test('OR across multiple selected stores', () => {
    const sel = _filterByStore(reports, new Set(['gog', 'epic']));
    expect(sel.map((r) => r.appId).sort()).toEqual(['epic:abc', 'gog:111']);
  });
});

describe('store filter group in the home Filters popover', () => {
  test('store group exists with All first and all supported stores', () => {
    expect(homeSrc).toContain('id="home-store-checks"');
    expect(homeSrc).toContain('class="pg-filter pg-filter--active" type="button" data-value="all"');
    ['steam', 'gog', 'epic'].forEach((s) => {
      expect(homeSrc).toContain(`data-value="${s}"`);
    });
  });
  test('storeSel is wired into both lists, the badge count, and clear', () => {
    expect(homeSrc).toContain('let storeSel = new Set()');
    expect(homeSrc).toContain('_filterByStore(_filterByType(_filterByTier(_sortReports(allRecentReports, currentSort), tierSel), sourceSel), storeSel)');
    expect(homeSrc).toContain('_filterByStore(_filterByType(_filterByTier(asReports, tierSel), sourceSel), storeSel)');
    expect(homeSrc).toContain('tierSel.size + sourceSel.size + storeSel.size');
    expect(homeSrc).toContain('storeSel = new Set();');
  });
  test('renderHomePage preloads the search index so GOG/Epic filters can pull stubs', () => {
    // Without this, storeSel = Set(['gog'|'epic']) hits the wantNonSteamOnly
    // path against a null searchIndex and renders no results.
    expect(homeSrc).toContain('loadSearchIndex().catch(() => null)');
  });
});

describe('store pill rendering', () => {
  test('renderGameCard renders both overlay and right-column pill; CSS controls position', () => {
    expect(cardSrc).toContain('storePill');
    expect(cardSrc).toContain('game-card-store-pill game-card-store-pill--');
    expect(cardSrc).toContain('game-card-store-tag game-card-store-pill--');
    expect(cardSrc).toContain('game-card-thumb-wrap');
  });
  test('cards.css defines a colour per store', () => {
    ['steam', 'gog', 'epic'].forEach((s) => {
      expect(cardsCss).toContain(`.game-card-store-pill--${s}`);
    });
  });
  test('home cards and list rows pass a storePill', () => {
    expect(homeSrc).toContain('storePill: storeLabel(appType)');
    expect(homeSrc).toContain('game-card-store-pill game-card-store-pill--${store.toLowerCase()}');
  });
  test('search results and dropdown show the store pill', () => {
    expect(searchSrc).toContain('storePill: storeLabelFromAppId(row.appId)');
    expect(searchSrc).toContain('storePill: store');
    expect(searchSrc).toContain('game-card-store-pill game-card-store-pill--${store.toLowerCase()}');
  });
});

describe('non-Steam box art', () => {
  const steamImgSrc = read('js/app/lib/steam-img.js');
  test('steam-img resolves gog/epic ids from nonsteam-images.json and skips the Steam CDN', () => {
    expect(steamImgSrc).toContain('nonsteam-images.json');
    expect(steamImgSrc).toContain("id.startsWith('gog:') || id.startsWith('epic:')");
    expect(steamImgSrc).toContain('route=nonsteam-images-json');
  });
  test('the game-page stub image routes through the loader bridge', () => {
    const gamePageSrc = read('js/app/components/game-page.js');
    expect(gamePageSrc).toContain('onerror="window.__steamImgLoad(this)"');
  });
  test('steam-img bumps window.__imgRouteCounts on every fallback route', () => {
    // The admin analytics image-routes section reads from this global. Each
    // route must call _bumpRoute so the dashboard counts are accurate.
    expect(steamImgSrc).toContain('window.__imgRouteCounts');
    expect(steamImgSrc).toContain("_bumpRoute('cloudflare')");
    expect(steamImgSrc).toContain("_bumpRoute('game-images-json')");
    expect(steamImgSrc).toContain("_bumpRoute('nonsteam-images-json')");
    expect(steamImgSrc).toContain("_bumpRoute('hidden')");
  });
});

describe('search index loads from prod on staging', () => {
  test('loadSearchIndex uses USES_PROD_DATA + SITE_ROOT, not a hardcoded host check', () => {
    expect(searchSrc).toContain('USES_PROD_DATA');
    expect(searchSrc).toContain('`${SITE_ROOT}/search-index.json`');
    expect(searchSrc).not.toContain("'https://www.proton-pulse.com/search-index.json'");
  });
});
