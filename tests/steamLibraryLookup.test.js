/**
 * #221: admin-only API Explorer proxy for keyed Steam Web API endpoints.
 *
 * The edge fn (supabase/functions/steam-library-lookup/index.ts) wraps three
 * Steam endpoints -- GetOwnedGames, GetRecentlyPlayedGames, ResolveVanityURL --
 * behind a manage_admins permission check + STEAM_WEB_API_KEY. This test file
 * pins the contract at the edge fn, the client wrapper, the Explorer wiring,
 * and the deploy plumbing so the Steam Web API key can never leak to a
 * non-admin caller.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EDGE = read('supabase/functions/steam-library-lookup/index.ts');
const API = read('js/admin/api/steam-library-lookup.js');
const COMP = read('js/admin/components/api-explorer.js');
const MAIN = read('js/admin/main.js');
const MANIFEST = read('gh-pages-manifest.txt').split('\n').map((l) => l.trim());
const CONFIG = read('supabase/config.toml');

describe('steam-library-lookup edge function', () => {
  test('whitelists exactly the three keyed endpoints', () => {
    expect(EDGE).toMatch(/const ENDPOINTS: Record<\s*string,/);
    expect(EDGE).toContain('steam_get_owned_games:');
    expect(EDGE).toContain('steam_get_recently_played:');
    expect(EDGE).toContain('steam_resolve_vanity:');
    // Rejects anything else -- guard against arbitrary URL forwarding.
    expect(EDGE).toContain('if (!meta) {');
    expect(EDGE).toContain('"unknown endpoint"');
  });

  test('builds the correct Steam Web API paths for each endpoint', () => {
    expect(EDGE).toContain('IPlayerService/GetOwnedGames/v1/');
    expect(EDGE).toContain('IPlayerService/GetRecentlyPlayedGames/v1/');
    expect(EDGE).toContain('ISteamUser/ResolveVanityURL/v1/');
    // Owned-games must include the appinfo + F2P flags so the JSON is useful.
    expect(EDGE).toContain('include_appinfo=1');
    expect(EDGE).toContain('include_played_free_games=1');
    // Vanity resolution is scoped to individual profiles.
    expect(EDGE).toContain('url_type=1');
  });

  test('requires an authenticated caller with manage_admins permission', () => {
    // Same auth pattern image-refetch uses (createRequestAuthClient +
    // current_user_has_permission). Anything else would defeat the admin
    // gating that keeps the Steam Web API key out of civilian hands.
    expect(EDGE).toContain('createRequestAuthClient(req)');
    expect(EDGE).toContain('auth.getUser()');
    expect(EDGE).toContain('current_user_has_permission');
    expect(EDGE).toContain('manage_admins');
    // Distinct 401 vs 403 branches so the client can render a useful error.
    expect(EDGE).toContain('"authentication required"');
    expect(EDGE).toContain('"manage_admins permission required"');
  });

  test('validates arg format before hitting Steam (defense against URL injection)', () => {
    expect(EDGE).toMatch(/const STEAMID_RE = \/\^\\d\{5,20\}\$\//);
    expect(EDGE).toMatch(/const VANITY_RE = \/\^\[A-Za-z0-9_-\]\{2,64\}\$\//);
    expect(EDGE).toContain('invalid ${meta.argName} format');
  });

  test('never returns the Steam Web API key in the response envelope', () => {
    // The url field is echoed to the client for the API Explorer view, so it
    // must have the key redacted. Anything else is a leak.
    expect(EDGE).toContain('const safeUrl = url.replace(encodeURIComponent(apiKey), "***")');
    expect(EDGE).toContain('url: safeUrl');
  });

  test('returns the steam-explore-shaped envelope so the Explorer renders uniformly', () => {
    // ok/endpoint/arg/url/method/status/data/error -- identical shape.
    for (const field of ['ok', 'endpoint', 'arg', 'url', 'method', 'status', 'data']) {
      expect(EDGE).toContain(`${field}:`);
    }
  });

  test('is registered in config.toml (verify_jwt handled inline like image-refetch)', () => {
    expect(CONFIG).toContain('[functions.steam-library-lookup]');
    // Every other proxy sets verify_jwt=false and does the auth inline; this
    // one MUST match so we can call the permission RPC ourselves.
    const section = CONFIG.split('[functions.steam-library-lookup]')[1] || '';
    expect(section.split('[functions.')[0]).toContain('verify_jwt = false');
  });
});

describe('steam-library-lookup client wrapper', () => {
  test('isLibraryEndpoint recognizes the three keyed endpoints', () => {
    expect(API).toContain("steam_get_owned_games");
    expect(API).toContain("steam_get_recently_played");
    expect(API).toContain("steam_resolve_vanity");
    expect(API).toContain('export function isLibraryEndpoint');
  });

  test('lookupLibrary attaches Bearer <access_token> so the edge fn can verify admin', () => {
    expect(API).toContain('SupaAuth.getSession');
    expect(API).toContain('session?.access_token');
    expect(API).toContain('Authorization: `Bearer ${session.access_token}`');
    // Never call the edge fn without a session token -- otherwise the fn 401s
    // and the client shows a confusing "no body" error instead of the real one.
    expect(API).toContain("'sign in as an admin first'");
  });

  test('routes steamid vs vanityurl to the correct payload field', () => {
    expect(API).toContain('steamid: String(steamid');
    expect(API).toContain('vanityurl: String(vanityurl');
  });
});

describe('API Explorer wiring for admin-only endpoints', () => {
  test('endpoints are declared under STORES.steam with adminGated:true', () => {
    for (const key of ['steam_get_owned_games', 'steam_get_recently_played', 'steam_resolve_vanity']) {
      expect(COMP).toContain(`{ key: '${key}',`);
    }
    expect(COMP).toContain('adminGated: true');
  });

  test('populateEndpoints filters admin-gated endpoints when canManageAdmins is false', () => {
    expect(COMP).toContain('canManageAdmins');
    expect(COMP).toContain('!e.adminGated || canManageAdmins');
  });

  test('_resolveArg has branches for steamid and vanity input types', () => {
    expect(COMP).toContain("endpointArg === 'steamid'");
    expect(COMP).toContain("endpointArg === 'vanity'");
    expect(COMP).toMatch(/\/\^\\d\{5,20\}\$\//);
    expect(COMP).toMatch(/\/\^\[A-Za-z0-9_-\]\{2,64\}\$\//);
  });

  test('doFetch routes library endpoints through lookupLibrary, not exploreStore', () => {
    expect(COMP).toContain("isLibraryEndpoint(endpoint)");
    expect(COMP).toContain('lookupLibrary(endpoint, { steamid: resolved.steamid, vanityurl: resolved.vanityurl })');
    // Public endpoints still go through the public proxy.
    expect(COMP).toContain('exploreStore(endpoint, { id: resolved.id, term: resolved.term })');
  });

  test('field-descriptions modal has entries for all three library endpoints', () => {
    for (const key of ['steam_get_owned_games', 'steam_get_recently_played', 'steam_resolve_vanity']) {
      expect(COMP).toContain(`${key}: {`);
    }
    // Body prose exists so the modal is not empty for these new endpoints.
    expect(COMP).toContain('GetOwnedGames');
    expect(COMP).toContain('GetRecentlyPlayedGames');
    expect(COMP).toContain('ResolveVanityURL');
  });

  test('main.js passes canManageAdmins into renderApiExplorer', () => {
    expect(MAIN).toContain("renderApiExplorer({ canManageAdmins: can('manage_admins') })");
  });

  test('gh-pages manifest lists the new client file so the deploy copies it', () => {
    expect(MANIFEST).toContain('js/admin/api/steam-library-lookup.js');
  });
});
