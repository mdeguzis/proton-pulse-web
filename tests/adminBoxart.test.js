/**
 * Source-shape pins for the admin "Missing Box Art" tab.
 *
 * Component is client-side heavy (loads three JSON files + probes
 * URLs with fetch); behavioural coverage would need jsdom + fetch mocks.
 * These pins catch the common wiring regressions: tab-option present,
 * loader mapped, component/api modules exported the entry points the
 * loader calls, and the manifest lists the new JS so gh-pages deploys
 * ship them.
 */

const fs = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const HTML   = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const MAIN   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'main.js'), 'utf8');
const COMP   = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'boxart.js'), 'utf8');
const API    = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'boxart.js'), 'utf8');
const PERMS  = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'permissions.js'), 'utf8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'gh-pages-manifest.txt'), 'utf8').split('\n');

describe('Box Art Manager admin tab wiring', () => {
  test('admin.html registers the tab option + section container', () => {
    expect(HTML).toContain('<option value="boxart">Box Art Manager</option>');
    expect(HTML).toContain('id="tab-boxart"');
    expect(HTML).toContain('id="boxart-content"');
  });

  test('admin main.js registers the loader + detail route in TAB_LOADERS', () => {
    expect(MAIN).toMatch(/import\s*\{\s*renderBoxartAdmin(?:,\s*renderBoxartAdminDetail)?\s*(?:,\s*[a-zA-Z_$][a-zA-Z0-9_$]*)*\s*\}\s*from\s*'\.\/components\/boxart\.js/);
    expect(MAIN).toMatch(/boxart:\s*\(\)\s*=>\s*renderBoxartAdmin\(\)/);
    expect(MAIN).toContain('renderBoxartAdminDetail');
    expect(MAIN).toMatch(/params\.get\('boxart'\)/);
  });

  test('boxart tab is gated by the same permission as analytics', () => {
    // view_analytics -- moderators + super_admin only. Adjust here (and
    // in permissions.js) if the requirement changes.
    expect(PERMS).toMatch(/boxart:\s*\['view_analytics'\]/);
  });

  test('manifest lists both new files so pages_only deploys ship them', () => {
    const lines = MANIFEST.map(l => l.trim());
    expect(lines).toContain('js/admin/api/boxart.js');
    expect(lines).toContain('js/admin/components/boxart.js');
  });
});

describe('Missing Box Art component contract', () => {
  test('exports renderBoxartAdmin', () => {
    expect(COMP).toMatch(/export async function renderBoxartAdmin\(/);
  });

  test('loads all three cache files (search-index, game-images, nonsteam-images)', () => {
    expect(COMP).toContain("dataUrl('search-index.json')");
    expect(COMP).toContain("dataUrl('game-images.json')");
    expect(COMP).toContain("dataUrl('nonsteam-images.json')");
  });

  test('renders search + store + scope + status filters and the two batch buttons', () => {
    expect(COMP).toContain('id="boxart-search"');
    expect(COMP).toContain('id="boxart-store"');
    expect(COMP).toContain('id="boxart-scope"');
    expect(COMP).toContain('id="boxart-status"');
    expect(COMP).toContain('id="boxart-probe-visible-btn"');
    expect(COMP).toContain('id="boxart-probe-all-btn"');
    expect(COMP).toContain('id="boxart-cancel-btn"');
  });

  test('status filter offers the five derived status values (incl. override)', () => {
    // These match _deriveStatus() output. If a status key is renamed
    // both the option value AND the filter branch have to move together.
    expect(COMP).toContain('value="override"');
    expect(COMP).toContain('value="default_cdn"');
    expect(COMP).toContain('value="fallback_cached"');
    expect(COMP).toContain('value="cached"');
    expect(COMP).toMatch(/<option value="missing">Missing/);
  });

  test('list-view row action is a single Details link', () => {
    // Previous versions rendered a 6-button pile per row (Probe /
    // Refetch / SGDB / Set URL / Upload / Clear). Those moved to the
    // detail view; the list row now only has one primary Details link.
    expect(COMP).toContain('data-action="details"');
    expect(COMP).toMatch(/href="\?boxart=\$\{encodeURIComponent\(r\.appId\)\}"/);
  });

  test('detail view exports render function and holds all action buttons', () => {
    expect(COMP).toMatch(/export async function renderBoxartAdminDetail\(appId\)/);
    // All six actions still exist -- just relocated to the detail view.
    // They live in the _DETAIL_ACTIONS array which _detailActionsHtml
    // renders as data-action="<action>" buttons.
    expect(COMP).toMatch(/action:\s*'probe'/);
    expect(COMP).toMatch(/action:\s*'refetch'/);
    expect(COMP).toMatch(/action:\s*'sgdb'/);
    expect(COMP).toMatch(/action:\s*'set-url'/);
    expect(COMP).toMatch(/action:\s*'upload'/);
    expect(COMP).toMatch(/action:\s*'clear'/);
    expect(COMP).toMatch(/data-action="\$\{a\.action\}"/);
  });

  test('detail view shows every URL source + highlights the live one', () => {
    expect(COMP).toMatch(/_urlRowHtml\('Admin override'/);
    expect(COMP).toMatch(/_urlRowHtml\('Default CDN \(akamai\)'/);
    expect(COMP).toMatch(/_urlRowHtml\('Cloudflare CDN'/);
    expect(COMP).toMatch(/'Pipeline fallback \(game-images\.json\)'/);
    expect(COMP).toMatch(/highlight:\s*currentSource === 'override'/);
  });

  test('set-url modal + hidden file input for uploads live in admin.html', () => {
    // Moved out of the component so both list and detail views share
    // one instance. The component only references these by ID.
    expect(HTML).toContain('id="boxart-modal-backdrop"');
    expect(HTML).toContain('id="boxart-modal-input"');
    expect(HTML).toContain('id="boxart-upload-input"');
    expect(HTML).toContain('accept="image/png,image/jpeg,image/webp"');
    // Component wires the modal by looking up those ids.
    expect(COMP).toContain("getElementById('boxart-modal-backdrop')");
    expect(COMP).toContain("getElementById('boxart-upload-input')");
  });

  test('admin override status label is present and hyperlinks to the URL', () => {
    expect(COMP).toContain('Admin override');
    // Override rows show a "view" link so the admin can confirm the URL.
    expect(COMP).toMatch(/admin-link[^"]*">view</);
  });

  test('scope="missing" no longer catches Steam default-CDN rows', () => {
    // Regression: "Missing" was defined as "no cached URL" which
    // caught ~32k Steam apps that use the standard CDN just fine.
    // The filter must key off the derived status (missing = only
    // rows we know have no source) not raw cachedUrl presence.
    expect(COMP).toMatch(/scope === 'has'\s+&& derivedStatus === 'missing'/);
    expect(COMP).toMatch(/scope === 'missing' && derivedStatus !== 'missing'/);
    // Signature grew to accept appId + knownMissingSteam + knownMissingNonSteam
    // so Steam entries flagged in game-images-cache.json AND non-Steam entries
    // reported by client onerror also count as missing (#199).
    expect(COMP).toMatch(/function _deriveStatus\(type, appId, cachedUrl, hasOverride, knownMissingSteam, knownMissingNonSteam\)/);
  });

  test('game title hyperlinks to the app page so admins can jump to it', () => {
    expect(COMP).toContain('_appHref(r.appId)');
    expect(COMP).toMatch(/app\.html#\/app\//);
  });

  test('store badge hyperlinks to the storefront page for that game', () => {
    // Steam: direct product page. GOG/Epic: title-search fallback (no
    // slug in the frontend index).
    expect(COMP).toContain('store.steampowered.com/app/');
    expect(COMP).toContain('www.gog.com/en/games?query=');
    expect(COMP).toContain('store.epicgames.com/en-US/browse?q=');
  });

  test('status column labels are user-facing ("Box art OK" / "Missing")', () => {
    expect(COMP).toContain('Box art OK');
    expect(COMP).toContain('Missing');
    // No stale FAIL badge left over.
    expect(COMP).not.toContain('">FAIL<');
  });

  test('Probe all runs in bounded batches and yields between them', () => {
    expect(COMP).toMatch(/const BATCH_SIZE = \d+/);
    expect(COMP).toMatch(/BATCH_YIELD_MS/);
    expect(COMP).toContain('cancelToken');
  });

  test('detail view uses delegated click for row actions', () => {
    // Actions moved to the detail view. The list view only exposes a
    // Details link; the detail view attaches click delegation to the
    // section content container.
    expect(COMP).toMatch(/content\.addEventListener\('click'/);
    expect(COMP).toMatch(/button\[data-action\]/);
  });

  test('pagination pushes at PAGE_SIZE per page', () => {
    expect(COMP).toMatch(/const PAGE_SIZE = 25/);
    expect(COMP).toContain('boxart-pager');
  });
});

describe('boxart API contract', () => {
  test('exports the probe/refetch entry points', () => {
    expect(API).toMatch(/export async function probeImageUrl\(/);
    expect(API).toMatch(/export async function probeSteamHeader\(/);
    expect(API).toMatch(/export async function refetchSteamHeader\(/);
    expect(API).toMatch(/export async function refetchNonSteamHeader\(/);
    expect(API).toMatch(/export async function refetchSgdbHeader\(/);
  });

  test('exports admin override write + list entry points', () => {
    expect(API).toMatch(/export async function setBoxArtOverride\(/);
    expect(API).toMatch(/export async function uploadBoxArtOverride\(/);
    expect(API).toMatch(/export async function clearBoxArtOverride\(/);
    expect(API).toMatch(/export async function listBoxArtOverrides\(/);
  });

  test('override writes send an admin JWT (not the anon key)', () => {
    // The edge function verifies manage_box_art permission via the JWT.
    // Anon-key-only requests must be rejected with 401.
    expect(API).toContain('SupaAuth.getSession');
    expect(API).toMatch(/Authorization:\s*`Bearer \$\{session\.access_token\}`/);
  });

  test('_authedFetch reads the session shape SupaAuth.getSession returns', () => {
    // Regression: initial version wrote `.then(r => r.data?.session)`
    // expecting the raw supabase-js shape, but SupaAuth.getSession()
    // already unwraps to session|null. That double-unwrap gave every
    // admin a "sign in as an admin first" error.
    expect(API).not.toMatch(/getSession\(\)\.then\(r =>\s*r\.data\?\.session\)/);
    expect(API).toMatch(/const session = await SupaAuth\.getSession\(\)\.catch/);
  });

  test('upload uses multipart FormData with app_id + source + file', () => {
    expect(API).toContain('new FormData()');
    expect(API).toMatch(/form\.append\('app_id'/);
    expect(API).toMatch(/form\.append\('source', 'upload_override'/);
    expect(API).toMatch(/form\.append\('file'/);
  });

  test('listBoxArtOverrides reads via anon-key REST (RLS grants SELECT to anon)', () => {
    expect(API).toContain('/rest/v1/box_art_overrides?select=');
  });

  test('refetch routes through the image-refetch edge function (not browser -> steam)', () => {
    // Steam appdetails is CORS-blocked from browsers; the server-side
    // proxy is the only working path. There must be no direct browser
    // fetch to store.steampowered.com/api/appdetails.
    expect(API).toContain('/functions/v1/image-refetch');
    expect(API).not.toMatch(/fetch\([^)]*store\.steampowered\.com\/api\/appdetails/);
    expect(API).toContain("_callImageRefetch(idStr, 'steam')");
    expect(API).toContain("_callImageRefetch(appId, 'sgdb')");
  });

  test('failures return a { ok:false, error } shape with a human-readable message', () => {
    expect(API).toMatch(/_result\(false,/);
    // Proxy transport error surfaces distinctly from upstream error.
    expect(API).toMatch(/proxy HTTP/);
  });

  test('probeImageUrl retries on HEAD-not-allowed (405) with an aborted GET', () => {
    expect(API).toContain('AbortController');
    expect(API).toMatch(/head\.status === 405/);
  });
});

describe('SteamGridDB search-and-pick', () => {
  const EDGE = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'image-refetch', 'index.ts'),
    'utf8',
  );

  test('edge function handles a sgdb_search source that returns a list', () => {
    expect(EDGE).toContain('source === "sgdb_search"');
    expect(EDGE).toContain('async function _sgdbSearch(');
    // title search path (autocomplete) + steam-id fallback
    expect(EDGE).toContain('/search/autocomplete/');
    // no dimension filter so non-460x215 games still return grids
    expect(EDGE).toContain('/grids/game/${gameId}?types=static');
    expect(EDGE).toContain('results: SgdbGrid[]');
  });

  test('api exports searchSgdb posting the sgdb_search source + term', () => {
    expect(API).toMatch(/export async function searchSgdb\(/);
    expect(API).toContain("source: 'sgdb_search'");
    expect(API).toContain('term: String(term');
  });

  test('component strips trademark symbols for the default search term', () => {
    expect(COMP).toMatch(/function _cleanTitle\(/);
    expect(COMP).toContain("replace(/[™®℠]/g, ' ')");
    expect(COMP).toContain('_cleanTitle(row.title)');
  });

  test('component renders a persistent search panel + results grid', () => {
    expect(COMP).toContain('id="boxart-sgdb-panel"');
    expect(COMP).toMatch(/function _sgdbPanelHtml\(/);
    expect(COMP).toMatch(/function _sgdbResultsHtml\(/);
    expect(COMP).toContain('data-sgdb="search"');
    expect(COMP).toContain('class="sgdb-grid"');
  });

  test('a result "Set as box art" writes the override via setBoxArtOverride', () => {
    expect(COMP).toContain('data-sgdb-set=');
    expect(COMP).toContain('await setBoxArtOverride(row.appId, url)');
    expect(COMP).toContain('searchSgdb');
  });

  test('panel links to the SteamGridDB website and has a dimension filter', () => {
    expect(COMP).toContain('steamgriddb.com/search/grids?term=');
    expect(COMP).toContain('Open on SteamGridDB');
    expect(COMP).toContain('id="sgdb-dims"');
    // widescreen (460x215 header shape) is the default box-art dimension
    expect(COMP).toContain('value="460x215,920x430" selected');
  });

  test('grid thumbnails open the full-size image in a new tab', () => {
    expect(COMP).toContain('class="sgdb-thumb-link"');
    expect(COMP).toContain('href="${escapeHtml(g.url)}" target="_blank"');
  });

  test('dimension filter flows through the api and edge function (sanitized)', () => {
    expect(API).toContain('dimensions: String(dimensions');
    expect(COMP).toContain("document.getElementById('sgdb-dims')?.value");
    expect(COMP).toContain('searchSgdb(row.appId, term, dims)');
    expect(EDGE).toContain('dimensions: string');
    expect(EDGE).toContain('/^[0-9x,]+$/.test(dimensions)');
    expect(EDGE).toContain('&dimensions=${dimSafe}');
  });

  // #199 follow-up: Steam games flagged as missing/delisted in
  // game-images-cache.json must surface under the "Missing box art" filter
  // so admins can override the exact games that render the "Box art missing"
  // tile on the client. Before this, _deriveStatus optimistically returned
  // 'default_cdn' for every Steam appid with no cached fallback URL.
  describe('surfaces known-missing Steam games from game-images-cache.json', () => {
    test('loader fetches game-images-cache.json', () => {
      expect(COMP).toContain("dataUrl('game-images-cache.json')");
    });

    test('loader builds a knownMissingSteam Set from status missing/delisted', () => {
      expect(COMP).toMatch(/knownMissingSteam\s*=\s*new Set\(\)/);
      expect(COMP).toMatch(/status\s*===\s*'missing'\s*\|\|\s*status\s*===\s*'delisted'/);
    });

    test('_deriveStatus flips Steam entries to missing when in knownMissingSteam', () => {
      expect(COMP).toMatch(/knownMissingSteam\.has\(appId\)\s*\)\s*return\s*'missing'/);
    });

    test('_buildRows destructures knownMissingSteam and threads it into _deriveStatus', () => {
      expect(COMP).toMatch(/function _buildRows\([^)]*knownMissingSteam[^)]*knownMissingNonSteam[^)]*\)/);
      expect(COMP).toMatch(/_deriveStatus\(type,\s*appId,\s*cachedUrl,\s*!!override,\s*knownMissingSteam,\s*knownMissingNonSteam\)/);
    });

    test('client-side image_load_errors are merged into the missing sets', () => {
      // Loader fetches recent onerror reports from the anon-read table so
      // admins see 404s happening in the wild for any store (#199 follow-up).
      expect(COMP).toContain('image_load_errors?select=app_id,store_type');
      // gog:/epic: ids partition into non-Steam set, everything else into Steam.
      expect(COMP).toMatch(/aid\.startsWith\('gog:'\)\s*\|\|\s*aid\.startsWith\('epic:'\)/);
    });

    test('nonsteam-images-cache.json missing entries merge into knownMissingNonSteam (#203)', () => {
      // Pipeline probe (nonsteam_images_probe.py) HEAD-checks every GOG/Epic
      // cover URL and records status:missing for 404s. Loader must pull the
      // cache and add those ids so admin surfaces broken covers even when no
      // user has hit the card yet.
      expect(COMP).toContain("dataUrl('nonsteam-images-cache.json')");
      expect(COMP).toMatch(/entry\?\.status\s*===\s*'missing'.*knownMissingNonSteam\.add/s);
    });
  });
});
