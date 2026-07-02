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

  test('admin main.js registers the loader in TAB_LOADERS', () => {
    expect(MAIN).toMatch(/import\s*\{\s*renderBoxartAdmin\s*\}\s*from\s*'\.\/components\/boxart\.js/);
    expect(MAIN).toMatch(/boxart:\s*\(\)\s*=>\s*renderBoxartAdmin\(\)/);
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

  test('renders search + store + scope filters and the two batch buttons', () => {
    expect(COMP).toContain('id="boxart-search"');
    expect(COMP).toContain('id="boxart-store"');
    expect(COMP).toContain('id="boxart-scope"');
    expect(COMP).toContain('id="boxart-probe-visible-btn"');
    expect(COMP).toContain('id="boxart-probe-all-btn"');
    expect(COMP).toContain('id="boxart-cancel-btn"');
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

  test('per-row Probe + Refetch actions are wired via delegated click', () => {
    expect(COMP).toContain('data-action="probe"');
    expect(COMP).toContain('data-action="refetch"');
    expect(COMP).toMatch(/table\.addEventListener\('click'/);
  });

  test('pagination pushes at PAGE_SIZE per page', () => {
    expect(COMP).toMatch(/const PAGE_SIZE = 25/);
    expect(COMP).toContain('boxart-pager');
  });
});

describe('boxart API contract', () => {
  test('exports the three probe/refetch entry points', () => {
    expect(API).toMatch(/export async function probeImageUrl\(/);
    expect(API).toMatch(/export async function probeSteamHeader\(/);
    expect(API).toMatch(/export async function refetchSteamHeader\(/);
    expect(API).toMatch(/export async function refetchNonSteamHeader\(/);
  });

  test('refetchSteamHeader hits the official appdetails endpoint', () => {
    expect(API).toContain('store.steampowered.com/api/appdetails');
    // filters=basic is smaller/faster payload -- keep it.
    expect(API).toMatch(/filters=basic/);
    expect(API).toContain('header_image');
  });

  test('failures return a { ok:false, error } shape with a human-readable message', () => {
    // The internal _result(false, { error }) helper wraps every failure
    // path; grepping for that pattern catches accidental raw throws.
    expect(API).toMatch(/_result\(false,/);
    // Specific friendly errors we expect the UI to show.
    expect(API).toMatch(/appdetails returned unsuccessful/);
    expect(API).toMatch(/appdetails returned no header_image/);
  });

  test('probeImageUrl retries on HEAD-not-allowed (405) with an aborted GET', () => {
    expect(API).toContain('AbortController');
    expect(API).toMatch(/head\.status === 405/);
  });
});
