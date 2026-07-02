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

  test('per-row actions include admin override controls', () => {
    expect(COMP).toContain('data-action="set-url"');
    expect(COMP).toContain('data-action="upload"');
    expect(COMP).toContain('data-action="clear"');
  });

  test('set-url modal + hidden file input for uploads exist', () => {
    expect(COMP).toContain('id="boxart-modal-backdrop"');
    expect(COMP).toContain('id="boxart-modal-input"');
    expect(COMP).toContain('id="boxart-upload-input"');
    // File picker restricts to image mimes matching the storage bucket allowlist.
    expect(COMP).toContain('accept="image/png,image/jpeg,image/webp"');
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
    expect(COMP).toMatch(/function _deriveStatus\(type, cachedUrl, hasOverride\)/);
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
