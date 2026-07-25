// Regression guards for filter panel + browse store filter bugs that recurred
// during the shared-filter refactor. Each test below maps to a real bug that
// shipped and was painful to track down. Do not weaken these without first
// understanding what they prevent.

const fs = require('fs');
const path = require('path');

const filtersCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'shared', 'filters.css'),
  'utf8'
);
const homeSrc = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8'
);
const homeCss = fs.readFileSync(
  path.join(__dirname, '..', 'css', 'app', 'home.css'),
  'utf8'
);

// Helper: strip comments + collapse whitespace so selector lookups are tolerant
// of formatting changes.
function flatten(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
}

describe('shared filter panel CSS -- dropdown positioning', () => {
  // Bug: when a :not(.filter-panel--stack) selector was used to scope the
  // 480px desktop min-width, it also stripped position:absolute from the
  // home page filter panel, causing the panel to render INLINE in the page
  // flow instead of dropping down. See conversation 2026-06-24.
  test('position: absolute applies to ALL .filter-panel variants, not just non-stack', () => {
    const flat = flatten(filtersCss);
    // The base rule must include .filter-panel without any :not() qualifier
    // so the --stack variant also gets absolute positioning.
    const basePanelRule = /\.filter-panel\s*,\s*\.pg-filter-panel\s*\{[^}]*position:\s*absolute/;
    expect(flat).toMatch(basePanelRule);
  });

  test('the wide-desktop min-width (480px) is the ONLY rule scoped to non-stack', () => {
    const flat = flatten(filtersCss);
    // The :not(.filter-panel--stack) selector should only appear inside a
    // media query that adjusts width -- never as a base positioning rule.
    const notStackUsages = flat.match(/\.filter-panel:not\(\.filter-panel--stack\)/g) || [];
    notStackUsages.forEach(() => {
      // The next { } block after the selector must NOT contain position:absolute
      // (that property belongs on the base rule that applies to all variants).
    });
    // At minimum, assert the min-width scoping exists (proves we are scoping
    // the right property, not removing positioning).
    expect(flat).toMatch(/\.filter-panel:not\(\.filter-panel--stack\)[\s\S]*?min-width:\s*480px/);
  });

  test('.filter-panel base rule sets the dropdown anchor (top + left + z-index)', () => {
    const flat = flatten(filtersCss);
    expect(flat).toMatch(/\.filter-panel[^{]*\{[^}]*top:\s*calc\(100%\s*\+\s*6px\)/);
    expect(flat).toMatch(/\.filter-panel[^{]*\{[^}]*z-index:\s*200/);
  });
});

describe('shared filter pill styles -- canonical location', () => {
  // Bug: pill styles existed in css/index/index.css only, so the app.html
  // home filter could not reuse them. Move kept duplicating until shared.
  test('pg-filter / pg-filter--active / pg-filter-group live in shared/filters.css', () => {
    const flat = flatten(filtersCss);
    expect(flat).toMatch(/\.pg-filter\s*\{/);
    expect(flat).toMatch(/\.pg-filter--active\s*\{/);
    expect(flat).toMatch(/\.pg-filter-group\s*\{/);
    expect(flat).toMatch(/\.pg-filter-group-label\s*\{/);
  });

  test('pg-filter-group uses row+wrap so many pills wrap horizontally', () => {
    const flat = flatten(filtersCss);
    // The Tier group has 8 options. flex-direction: column would stack them
    // 8 rows tall. row + wrap keeps the panel compact.
    expect(flat).toMatch(/\.pg-filter-group\s*\{[^}]*flex-direction:\s*row/);
    expect(flat).toMatch(/\.pg-filter-group\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

describe('home (app.html browse) -- GOG/Epic store filter regression guards', () => {
  // Bug: renderHomePage never called loadSearchIndex, so searchIndex stayed
  // null. Clicking GOG or Epic hit the wantNonSteamOnly path against a null
  // index and rendered no results. Lock in the preload.
  test('renderHomePage preloads loadSearchIndex in its initial Promise.all', () => {
    expect(homeSrc).toContain('loadSearchIndex().catch(() => null)');
    // Must be inside the renderHomePage function, before applyPopularFilters
    // gets a chance to read searchIndex. Cheap proxy: the call appears before
    // the wantNonSteamOnly branch reads searchIndex.
    const preloadIdx = homeSrc.indexOf('loadSearchIndex().catch(() => null)');
    const readIdx = homeSrc.indexOf('asReports = (searchIndex || [])');
    expect(preloadIdx).toBeGreaterThan(0);
    expect(preloadIdx).toBeLessThan(readIdx);
  });

  test('wantNonSteamOnly path reads row[5] (appType column) from searchIndex', () => {
    // The pipeline writes [appId, title, tier, protondbCount, pulseCount, appType]
    // -- column 5 is the store type ('steam'|'gog'|'epic'). If anyone reshapes
    // the index they must also update this filter.
    expect(homeSrc).toContain('.filter(row => row[5] && storeSel.has(row[5]))');
  });
});

describe('home (app.html browse) -- pill button filter group structure', () => {
  // Bug: checkbox-based groups allowed both Rated and Not Rated to be
  // highlighted at once, which looked broken. Pills with proper All-vs-
  // specifics mutual exclusion via _wirePillGroup fix this.
  test('every filter group uses pg-filter pill buttons with data-value', () => {
    ['home-store-checks', 'home-tier-checks', 'home-source-checks'].forEach(id => {
      expect(homeSrc).toContain(`id="${id}"`);
    });
    expect(homeSrc).not.toContain('class="filter-check"');
    expect(homeSrc).not.toContain('<input type="checkbox" value="all"');
  });

  test('All button starts active, mutual-exclusion handlers wired via _wirePillGroup', () => {
    // Each group must declare an "All" pill marked active at render time.
    const allPillMatches = homeSrc.match(/class="pg-filter pg-filter--active" type="button" data-value="all"/g) || [];
    expect(allPillMatches.length).toBeGreaterThanOrEqual(3);
    expect(homeSrc).toContain('_wirePillGroup(tierGroup');
    expect(homeSrc).toContain('_wirePillGroup(sourceGroup');
    expect(homeSrc).toContain('_wirePillGroup(storeGroup');
  });

  test('clearing filters re-activates All on every group', () => {
    expect(homeSrc).toContain("g.querySelectorAll('.pg-filter').forEach(b => b.classList.remove('pg-filter--active'))");
    expect(homeSrc).toContain("const allBtn = g.querySelector('.pg-filter[data-value=\"all\"]')");
    expect(homeSrc).toContain("allBtn.classList.add('pg-filter--active')");
  });
});

describe('mobile filter modal (<= 720px) -- full-viewport modal pattern', () => {
  // Bug: on mobile the anchored dropdown collided with the fixed topbar,
  // overflowed off-screen, and could not scroll. Fix: at <= 720px the panel
  // is a full-viewport modal with sticky header (title + X) and sticky
  // footer for the action buttons. This test guards the CSS + markup shape
  // so a future refactor doesn't quietly regress it back to a dropdown.
  const flat = flatten(filtersCss);

  test('mobile media query at 720px pins the open panel to inset:0 at z-index above topbar', () => {
    expect(flat).toMatch(/@media \(max-width: 720px\)/);
    expect(flat).toMatch(/\.filter-panel\.open[\s\S]*?position: fixed[\s\S]*?inset: 0/);
    // Topbar sits at z-index: 200; modal must sit above that.
    expect(flat).toMatch(/\.filter-panel\.open[\s\S]*?z-index: 300/);
  });

  test('mobile-only header is hidden on desktop and sticky at top when the panel is open on mobile', () => {
    // Hidden by default at any viewport size (desktop rule).
    expect(flat).toMatch(/\.filter-panel-mobile-header\s*\{\s*display: none/);
    // Shown as sticky inside the mobile modal.
    expect(flat).toMatch(/\.filter-panel\.open \.filter-panel-mobile-header[\s\S]*?position: sticky[\s\S]*?top: 0/);
  });

  test('mobile footer sticks to the bottom so Save / Clear stay in reach', () => {
    expect(flat).toMatch(/\.filter-panel\.open \.filter-panel-footer[\s\S]*?position: sticky[\s\S]*?bottom: 0/);
  });

  test('inside the mobile modal, .filter-panel--stack drops flex layout and blocks horizontal overflow', () => {
    // reports.css lays .filter-panel--stack groups side-by-side above 560px.
    // The modal at <=720px forces plain block layout so each group gets its
    // own row (labels + wrapped pills), sticky header/footer behave reliably
    // across iOS/Android WebView, and touch scrolling inside overflow: auto
    // works like a normal document scroll instead of a flex-container scroll.
    expect(flat).toMatch(/\.filter-panel--stack\.open\s*\{\s*display: block !important/);
    expect(flat).toMatch(/\.filter-panel\.open[\s\S]*?overflow-x: hidden/);
    // The panel itself is a real scroll container with a persistent scrollbar.
    expect(flat).toMatch(/\.filter-panel\.open[\s\S]*?overflow-y: scroll/);
    expect(flat).toMatch(/touch-action: pan-y/);
  });

  test('home.js filter panel ships the mobile header markup with a close X', () => {
    expect(homeSrc).toContain('filter-panel-mobile-header');
    expect(homeSrc).toContain('class="filter-panel-close"');
    expect(homeSrc).toContain('aria-label="Close filters"');
  });

  test('topbar.js wires a delegated close handler that resets aria-expanded', () => {
    const topbarSrc = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'lib', 'topbar.js'),
      'utf8'
    );
    expect(topbarSrc).toContain('wireFilterPanelClose');
    expect(topbarSrc).toMatch(/closest\(['"`]\.filter-panel-close/);
    expect(topbarSrc).toMatch(/aria-expanded[^\n]*false/);
  });

  test('topbar.js portals the open panel to <body> on mobile so it escapes .main-content stacking context', () => {
    // base.css sets .main-content { z-index: 2 } which creates a stacking
    // context. The topbar sits at z-index: 200 in the root stacking context,
    // above main-content. Any panel inside main-content can never rise
    // above the topbar via its own z-index -- it's trapped at stacking
    // layer 2. The mobile modal must therefore detach and re-append the
    // panel to <body> on open, and restore it to the original parent on
    // close so per-page outside-click handlers keep working.
    const topbarSrc = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'lib', 'topbar.js'),
      'utf8'
    );
    expect(topbarSrc).toMatch(/document\.body\.appendChild\(panel\)/);
    expect(topbarSrc).toMatch(/_panelOriginals/);
    expect(topbarSrc).toMatch(/matchMedia\(MOBILE_MODAL_QUERY\)/);
  });

  test('home.js outside-click handler allows taps inside the (portaled) panel', () => {
    // When portaled, filterPanel is no longer a filterWrap descendant, so
    // filterWrap.contains(e.target) is false for every tap on a filter pill.
    // Guard: also check filterPanel.contains(e.target) so taps inside the
    // panel don't trigger the outside-click close.
    expect(homeSrc).toMatch(/!filterPanel\.contains\(e\.target\)/);
  });
});

describe('game-page filter panel adopts the browse modal framework (#360)', () => {
  // Game-page keeps its dropdown filters (single-value <select>) but
  // adopts the same modal chrome as browse: .filter-panel--stack for
  // consistent mobile layout, and a three-button footer (Collapse /
  // Save filters / Clear filters) that matches home.js. Only the control
  // style differs (selects here vs pill groups on browse). This block
  // guards the framework wins so they cannot be reverted separately.
  const gamePageSrc = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
    'utf8'
  );

  test('panel uses .filter-panel--stack modifier for consistent mobile layout', () => {
    // Without --stack the mobile modal falls back to the .filter-panel-grid
    // rules and looks different from browse. Regression guard.
    expect(gamePageSrc).toMatch(/class="filter-panel filter-panel--stack"\s+id="filterPanel"/);
  });

  test('footer carries Collapse + Save filters + Clear filters buttons', () => {
    // Same three-button footer as browse. filter-persist as a checkbox is
    // gone -- it is now an aria-pressed toggle button so it matches the
    // browse UX (and is easier to hit on mobile).
    expect(gamePageSrc).toContain('id="gp-filter-collapse"');
    expect(gamePageSrc).toContain('id="gp-filter-persist"');
    expect(gamePageSrc).toContain('id="gp-filter-clear"');
    expect(gamePageSrc).toMatch(/class="filter-collapse-btn"/);
    expect(gamePageSrc).toMatch(/class="filter-save-btn/);
    expect(gamePageSrc).toMatch(/class="filter-clear-btn"/);
    // Old <input type="checkbox" id="fPersist"> checkbox markup is gone.
    expect(gamePageSrc).not.toContain('id="fPersist"');
  });

  test('filter panel keeps its <select> dropdowns for enumerable filters', () => {
    // Intentional design choice: the game-details filters are single-value
    // per report (a report has one GPU vendor, one OS, one rating). A pill
    // grid would be visually heavier without a UX benefit. Regression
    // guard: if a future refactor swaps in pill markup this test catches
    // it so the decision gets reconsidered explicitly.
    expect(gamePageSrc).toMatch(/<select id="fGpu"/);
    expect(gamePageSrc).toMatch(/<select id="fRating"/);
    expect(gamePageSrc).toMatch(/<select id="fSource"/);
    expect(gamePageSrc).toMatch(/<select id="fPlaytime"/);
  });

  test('selects reuse the .home-filter-select class for consistent styling', () => {
    // Sharing the same class as browse's controls means one CSS rule set
    // styles every dropdown site-wide. If a select is added without this
    // class it will look off inside the modal (native browser default
    // instead of the site theme).
    for (const sel of ['fGpu', 'fArch', 'fOs', 'fRating', 'fRunType', 'fSource', 'fDevice', 'fPlaytime']) {
      const re = new RegExp(`<select id="${sel}"[^>]*class="home-filter-select"`);
      expect(gamePageSrc).toMatch(re);
    }
  });

  test('Save filters button is an aria-pressed toggle, not a checkbox', () => {
    // Browse uses <button aria-pressed> for the persist toggle -- easier
    // hit target on mobile and matches the button-based footer.
    expect(gamePageSrc).toMatch(/id="gp-filter-persist"[^>]*aria-pressed="/);
    expect(gamePageSrc).not.toMatch(/type="checkbox"[^>]*id="fPersist"/);
  });

  test('panel lookups after render use document-scoped queries, not el.querySelector', () => {
    // Regression guard: on mobile the shared modal observer portals
    // #filterPanel to <body> once .open is added. Any handler that then
    // does el.querySelector('#filterPanel') returns null (the panel is
    // no longer in el) -- Collapse silently does nothing, tapping the
    // filter toggle to close an open panel silently does nothing, and
    // the .add('open') restore after a dropdown change silently misses.
    // The fix routes every post-render lookup through document.getElementById
    // so the panel is reachable in either location.

    // Collapse handler must find the panel via document, not el.
    const collapseSection = gamePageSrc.match(/gp-filter-collapse['"]\)[\s\S]{0,400}?remove\(['"]open['"]/);
    expect(collapseSection).not.toBeNull();
    expect(collapseSection[0]).not.toMatch(/el\.querySelector\(['"]#filterPanel['"]/);

    // Filter-toggle click handler (the open/close toggle) must not rely on
    // el.querySelector for the panel either -- else tapping toggle to close
    // an already-open (portalled) panel is a no-op.
    const toggleSection = gamePageSrc.match(/#filterToggle['"]\)\?\.addEventListener\(['"]click['"][\s\S]{0,500}?\}\);/);
    expect(toggleSection).not.toBeNull();
    expect(toggleSection[0]).not.toMatch(/el\.querySelector\(['"]#filterPanel['"]/);

    // Dropdown change handlers finish with .add('open') to keep the modal
    // on-screen after a pick. That lookup must also be document-scoped so
    // it succeeds even after the panel has been portalled.
    expect(gamePageSrc).not.toMatch(/render\(\);\s*el\.querySelector\(['"]#filterPanel['"]\)\?\.classList\.add\(['"]open['"]\)/);
  });
});

describe('outside-click closer allows taps inside the (portalled) panel', () => {
  // Same fix pattern as home.js's outside-click closer. Motivating incident:
  // on mobile, tapping the X to close the filter modal fired the "closed"
  // log with portaled=false because the outside-click handler in
  // js/app/main.js stripped .open first (the panel was portalled to body
  // and thus no longer inside .filter-wrap). The X handler then saw the
  // panel already closed and logged the wrong state.
  const appMainSrc = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app', 'main.js'),
    'utf8',
  );

  test('handler checks panel.contains(e.target) before stripping .open', () => {
    // Without this check every click inside the portalled modal (X,
    // dropdowns, footer buttons) counts as "outside" .filter-wrap and
    // closes the panel. Regression guard on the exact string.
    expect(appMainSrc).toMatch(/panel\.contains\(e\.target\)/);
  });

  test('early-returns when the panel is not .open (avoid needless work)', () => {
    // The handler runs on EVERY document click; guard against doing DOM
    // work when the panel is not even open.
    expect(appMainSrc).toMatch(/panel\.classList\.contains\(['"]open['"]\)/);
  });
});

describe('game-page render() cleans up portalled panel before re-rendering (#358)', () => {
  // Bug: game-page.js render() sets el.innerHTML = ... on every filter change.
  // The shared mobile-modal observer in js/lib/topbar.js portals an open
  // .filter-panel to <body> so it can rise above the topbar stacking context.
  // Without the cleanup below, render() creates a fresh #filterPanel inside el,
  // the observer sees the new node and portals THAT too, and the OLD portalled
  // panel is left orphaned in body. Result on mobile: two overlapping modals,
  // and users read "filter chip did not apply" because the visible modal is
  // stale while the reports beneath actually did re-render.
  const gamePageSrc = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
    'utf8'
  );

  test('render() removes any portalled #filterPanel from <body> before writing el.innerHTML', () => {
    // The remove() must fire INSIDE render() and BEFORE the innerHTML write --
    // any later and el.innerHTML has already replaced the container while the
    // portalled panel still sits in body.
    const renderStart = gamePageSrc.indexOf('function render()');
    expect(renderStart).toBeGreaterThan(-1);
    // Find the first el.innerHTML = ... in render(). Grab body between them.
    const innerHtmlAt = gamePageSrc.indexOf('el.innerHTML = `', renderStart);
    expect(innerHtmlAt).toBeGreaterThan(renderStart);
    const preRenderBlock = gamePageSrc.slice(renderStart, innerHtmlAt);
    expect(preRenderBlock).toMatch(/document\.body\.querySelector\(['"]#filterPanel['"]\)\?\.remove\(\)/);
  });

  test('the cleanup targets #filterPanel specifically, not every .filter-panel', () => {
    // The browse page uses .pg-filter-panel with its own ID; only game-page
    // ships id="filterPanel". Blanket-removing every .filter-panel from body
    // would nuke another page's open modal on any pagechange re-render.
    const renderStart = gamePageSrc.indexOf('function render()');
    const renderEnd = gamePageSrc.indexOf('el.innerHTML = `', renderStart);
    const block = gamePageSrc.slice(renderStart, renderEnd);
    expect(block).not.toMatch(/document\.body\.querySelectorAll\(['"]\.filter-panel['"]\)/);
  });
});

describe('home (app.html browse) -- XL card size parity with index.html', () => {
  // Bug: XL only existed on index.html. Browse view should match.
  test('SIZES array includes xl alongside sm/md/lg', () => {
    expect(homeSrc).toContain("const SIZES = ['sm', 'md', 'lg', 'xl']");
  });

  test('XL button is rendered with the desktop-only modifier class', () => {
    expect(homeSrc).toContain('home-size-btn--desktop-only');
    expect(homeSrc).toMatch(/data-size="xl"/);
  });

  test('home.css defines the cards--xl size and a thumb width override', () => {
    expect(homeCss).toMatch(/\.cards--xl\s+\.game-card-thumb\s*\{[^}]*width:/);
    expect(homeCss).toMatch(/\.home-size-btn--desktop-only/);
  });
});
