/**
 * Admin API Explorer (issue #186): inspect raw store JSON for a game via the
 * steam-explore edge function proxy (stores are CORS-blocked from the browser).
 * Covers Steam / GOG / Epic.
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

describe('API Explorer edge function (multi-store)', () => {
  test('whitelists steam / gog / epic endpoints', () => {
    for (const key of ['steam_appdetails', 'steam_deck', 'gog_product', 'gog_search', 'epic_search']) {
      expect(EDGE).toContain(`${key}:`);
    }
    expect(EDGE).toContain('ajaxgetdeckappcompatibilityreport?nAppID=');
    expect(EDGE).toContain('api.gog.com/products/');
    expect(EDGE).toContain('store.epicgames.com/graphql');
  });

  test('whitelists ProtonDB endpoints (#280)', () => {
    // Summary is the per-app data check the admin panel actually cares
    // about; counts is a global sanity endpoint. Both live upstream at
    // protondb.com; pin the URLs so a rename gets a failing test.
    expect(EDGE).toContain('protondb_summary:');
    expect(EDGE).toContain('protondb_counts:');
    expect(EDGE).toContain('protondb.com/api/v1/reports/summaries/');
    expect(EDGE).toContain('protondb.com/data/counts.json');
  });

  test('id endpoints require a numeric id; term endpoints require a term', () => {
    expect(EDGE).toContain('const def = ENDPOINTS[endpoint]');
    expect(EDGE).toContain('/^\\d+$/.test(id)');
    expect(EDGE).toContain('if (!term)');
  });

  test('is registered in config.toml with verify_jwt=false', () => {
    expect(CONFIG).toContain('[functions.steam-explore]');
  });
});

describe('API Explorer client + component', () => {
  test('api posts endpoint + id/term to the steam-explore function', () => {
    expect(API).toMatch(/export async function exploreStore\(/);
    expect(API).toContain('/functions/v1/steam-explore');
    expect(API).toContain('endpoint: String(endpoint)');
    expect(API).toContain('id: String(id)');
    expect(API).toContain('term: String(term)');
  });

  test('component has store tabs for Steam / GOG / Epic + ProtonDB', () => {
    expect(COMP).toContain('const STORES = {');
    expect(COMP).toContain('class="apix-store-tab');
    expect(COMP).toContain("store = tab.dataset.store");
    expect(COMP).toMatch(/steam:\s*{/);
    expect(COMP).toMatch(/gog:\s*{/);
    expect(COMP).toMatch(/epic:\s*{/);
    expect(COMP).toMatch(/protondb:\s*{/);
    // ProtonDB tab lists both endpoints so the admin can pick which one
    // to hit -- summary (per app) or counts (global sanity).
    expect(COMP).toContain("key: 'protondb_summary'");
    expect(COMP).toContain("key: 'protondb_counts'");
  });

  test('ProtonDB name lookup reuses the Steam appid index (#280)', () => {
    // ProtonDB is keyed by Steam appid upstream, so typing a game name in
    // the ProtonDB tab must resolve against the same rows as the Steam
    // tab. Regression: initial version only matched "store === 'steam'"
    // and left ProtonDB name lookups returning "no match".
    expect(COMP).toMatch(/store === 'steam' \|\| store === 'protondb'/);
  });

  test('ProtonDB fields are documented so the "Field descriptions" popup works', () => {
    // FIELD_DOCS entries are what the popup renders. Missing the key
    // makes the popup fall back to steam_appdetails, which is wrong.
    expect(COMP).toContain('protondb_summary: {');
    expect(COMP).toContain('protondb_counts: {');
    expect(COMP).toContain("trendingTier");
    expect(COMP).toContain("bestReportedTier");
  });

  test('resolves an id/name/term and renders the JSON', () => {
    expect(COMP).toMatch(/export function renderApiExplorer\(/);
    expect(COMP).toContain('async function _resolveArg(');
    expect(COMP).toContain('/^\\d+$/.test(q)');           // numeric passes through
    expect(COMP).toContain("dataUrl('search-index.json')"); // name resolution source
    expect(COMP).toContain("id = id.slice(prefix.length)"); // strips gog:/epic: prefix
    expect(COMP).toContain('exploreStore(endpoint, { id: resolved.id, term: resolved.term })');
  });

  test('output has a word-wrap toggle, copy, download, and store-link controls', () => {
    expect(COMP).toContain('id="apix-wrap"');
    expect(COMP).toContain("classList.toggle('apix-wrap'");
    expect(COMP).toContain('navigator.clipboard.writeText(lastJson)');
    expect(COMP).toContain("new Blob([lastJson], { type: 'application/json' })");
    expect(COMP).toContain('a.download = `${lastName}.json`');
    // store-page link, derived per endpoint
    expect(COMP).toContain('id="apix-store-link"');
    expect(COMP).toContain('function _storeUrl(');
    expect(COMP).toContain('store.steampowered.com/app/${id}');
    expect(COMP).toContain('links.product_card');
  });

  test('Field descriptions popup documents fields for each store endpoint', () => {
    expect(COMP).toContain('id="apix-fields"');
    expect(COMP).toContain('function _showFieldDocs(');
    expect(COMP).toContain('const FIELD_DOCS = {');
    expect(COMP).toContain('content_descriptors.ids');
    expect(COMP).toContain('resolved_category');
    expect(COMP).toContain('display_type');
    expect(COMP).toContain('required_age');
    // gog + epic docs present
    expect(COMP).toContain('gog_product:');
    expect(COMP).toContain('epic_search:');
  });
});

describe('API Explorer admin wiring', () => {
  test('admin.html has the tab option + content container', () => {
    expect(HTML).toContain('<option value="api-explorer">API Explorer</option>');
    expect(HTML).toContain('id="api-explorer-content"');
  });

  test('main.js maps the tab to renderApiExplorer with the admin permission flag', () => {
    expect(MAIN).toContain('import { renderApiExplorer }');
    // #221: the admin-gated Steam Web API endpoints (GetOwnedGames etc.)
    // need the `canManageAdmins` flag to decide whether to surface them.
    expect(MAIN).toContain("renderApiExplorer({ canManageAdmins: can('manage_admins') })");
  });

  test('tab is gated behind view_analytics like the other tools', () => {
    expect(PERMS).toMatch(/'api-explorer':\s*\['view_analytics'\]/);
  });

  test('manifest lists the new admin files so pages_only deploys ship them', () => {
    expect(MANIFEST).toContain('js/admin/api/steam-explore.js');
    expect(MANIFEST).toContain('js/admin/components/api-explorer.js');
  });
});
