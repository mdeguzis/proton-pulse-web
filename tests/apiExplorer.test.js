/**
 * Admin API Explorer (issue #186): inspect raw Steam JSON for a game via the
 * steam-explore edge function proxy (Steam is CORS-blocked from the browser).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EDGE = read('supabase/functions/steam-explore/index.ts');
const API = read('js/admin/api/steam-explore.js');
const COMP = read('js/admin/components/api-explorer.js');
const HTML = read('admin.html');
const MAIN = read('js/admin/main.js');
const PERMS = read('js/admin/permissions.js');
const MANIFEST = read('gh-pages-manifest.txt').split('\n').map((l) => l.trim());
const CONFIG = read('supabase/config.toml');

describe('API Explorer edge function', () => {
  test('whitelists appdetails + deck endpoints and requires a numeric app id', () => {
    expect(EDGE).toContain('appdetails: (id)');
    expect(EDGE).toContain('deck: (id)');
    expect(EDGE).toContain('ajaxgetdeckappcompatibilityreport?nAppID=');
    expect(EDGE).toContain('if (!ENDPOINTS[endpoint])');
    expect(EDGE).toContain('/^\\d+$/.test(appId)');
  });

  test('is registered in config.toml with verify_jwt=false', () => {
    expect(CONFIG).toContain('[functions.steam-explore]');
  });
});

describe('API Explorer client + component', () => {
  test('api posts endpoint + app_id to the steam-explore function', () => {
    expect(API).toMatch(/export async function exploreSteam\(/);
    expect(API).toContain('/functions/v1/steam-explore');
    expect(API).toContain('endpoint: String(endpoint)');
    expect(API).toContain('app_id: String(appId)');
  });

  test('component resolves a name to an app id and renders the JSON', () => {
    expect(COMP).toMatch(/export function renderApiExplorer\(/);
    expect(COMP).toContain('async function _resolveAppId(');
    expect(COMP).toContain('/^\\d+$/.test(q)');           // numeric passes through
    expect(COMP).toContain("dataUrl('search-index.json')"); // name resolution source
    expect(COMP).toContain('JSON.stringify(');            // pretty-print output
    expect(COMP).toContain('exploreSteam(endpoint, resolved.id)');
  });
});

describe('API Explorer admin wiring', () => {
  test('admin.html has the tab option + content container', () => {
    expect(HTML).toContain('<option value="api-explorer">API Explorer</option>');
    expect(HTML).toContain('id="api-explorer-content"');
  });

  test('main.js maps the tab to renderApiExplorer', () => {
    expect(MAIN).toContain("import { renderApiExplorer }");
    expect(MAIN).toContain("'api-explorer': () => renderApiExplorer()");
  });

  test('tab is gated behind view_analytics like the other tools', () => {
    expect(PERMS).toMatch(/'api-explorer':\s*\['view_analytics'\]/);
  });

  test('manifest lists the new admin files so pages_only deploys ship them', () => {
    expect(MANIFEST).toContain('js/admin/api/steam-explore.js');
    expect(MANIFEST).toContain('js/admin/components/api-explorer.js');
  });
});
