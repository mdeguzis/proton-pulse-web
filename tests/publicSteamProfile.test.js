/**
 * #299: public /lookup Steam profile page + edge function.
 *
 * The edge fn (supabase/functions/public-steam-profile/index.ts) is anonymous
 * (verify_jwt=false) and takes a Steam profile URL / vanity / SteamID64 and
 * returns the owned-games list. This file pins:
 *
 *   1. parseSteamProfileInput handles every URL shape we advertise.
 *   2. The edge fn is registered public in config.toml, so a signed-out caller
 *      can actually hit it.
 *   3. The lookup page and its assets are on the gh-pages manifest.
 *   4. The lookup frontend targets the right edge fn + carries direct-link
 *      support via ?steamId=.
 *   5. The sign-in hint reappears wherever we prompt sign-in.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EDGE = read('supabase/functions/public-steam-profile/index.ts');
const CONFIG = read('supabase/config.toml');
const LOOKUP_MAIN = read('js/lookup/main.js');
const LOOKUP_HTML = read('lookup.html');
const MANIFEST = read('gh-pages-manifest.txt').split('\n').map((l) => l.trim());
const TOPBAR = read('js/lib/topbar.js');

describe('parseSteamProfileInput contract (source-level, since Deno TS cannot be run in Jest)', () => {
  test('accepts a raw 17-digit SteamID64 as kind=steamid', () => {
    expect(EDGE).toMatch(/STEAMID_RE\s*=\s*\/\^\\d\{17\}\$\//);
    expect(EDGE).toContain(`if (STEALESS)`.replace(/.*/, "if (STEAMID_RE.test(trimmed)) return { kind: \"steamid\", value: trimmed };"));
  });
  test('accepts a bare vanity name (no slash) as kind=vanity', () => {
    expect(EDGE).toMatch(/VANITY_RE\s*=\s*\/\^\[A-Za-z0-9_-\]\{2,64\}\$\//);
    expect(EDGE).toContain(`if (VANITY_RE.test(trimmed) && !trimmed.includes("/"))`);
  });
  test('parses steamcommunity.com/profiles/<id> and /id/<vanity>', () => {
    expect(EDGE).toMatch(/\/\^\\\/profiles\\\/\(\\d\{17\}\)\(\?:\\\/\|\$\)\//);
    expect(EDGE).toMatch(/\/\^\\\/id\\\/\(\[A-Za-z0-9_-\]\{2,64\}\)\(\?:\\\/\|\$\)\//);
  });
  test('rejects unrelated hosts (only steamcommunity.com is honored)', () => {
    expect(EDGE).toContain(`host !== "steamcommunity.com" && host !== "www.steamcommunity.com"`);
  });
  test('accepts scheme-less URLs by defaulting to https://', () => {
    expect(EDGE).toContain('/^https?:\\/\\//.test(trimmed) ? trimmed : `https://${trimmed}`');
  });
});

describe('public-steam-profile edge function shape', () => {
  test('uses ResolveVanityURL and GetOwnedGames', () => {
    expect(EDGE).toContain('/ISteamUser/ResolveVanityURL/v1/');
    expect(EDGE).toContain('/IPlayerService/GetOwnedGames/v1/');
    expect(EDGE).toContain('/ISteamUser/GetPlayerSummaries/v2/');
  });
  test('reads STEAM_API_KEY from env and returns 500 when missing', () => {
    expect(EDGE).toContain(`Deno.env.get("STEAM_API_KEY")`);
    expect(EDGE).toContain('missing_key');
  });
  test('never echoes the API key back to the caller', () => {
    expect(EDGE).not.toMatch(/return[\s\S]{0,80}apiKey/);
  });
  test('vanity resolution failure returns 404 vanity_not_found', () => {
    expect(EDGE).toContain('vanity_not_found');
    expect(EDGE).toMatch(/return json\(\{[^}]*error: r\.error[^}]*\}, 404\)/);
  });
  test('surfaces public-visibility flag from GetPlayerSummaries', () => {
    expect(EDGE).toContain('communityvisibilitystate');
    expect(EDGE).toMatch(/communityvisibilitystate\s*\?\?\s*0\)\s*===\s*3/);
  });
});

describe('supabase/config.toml public-steam-profile registration', () => {
  test('function is marked verify_jwt = false so it is publicly callable', () => {
    expect(CONFIG).toContain('[functions.public-steam-profile]');
    // The whole point of #299: no auth required. If we ever add verify_jwt
    // = true here the signed-out lookup silently breaks with 401.
    const section = CONFIG.split('[functions.public-steam-profile]')[1] || '';
    expect(section).toMatch(/verify_jwt\s*=\s*false/);
  });
});

describe('lookup.html + js/lookup/main.js wiring', () => {
  test('lookup.html renders the form + result mount', () => {
    expect(LOOKUP_HTML).toContain('id="lookup-form"');
    expect(LOOKUP_HTML).toContain('id="lookup-input"');
    expect(LOOKUP_HTML).toContain('id="lookup-chart-mount"');
    expect(LOOKUP_HTML).toContain('id="lookup-private"');
  });
  test('lookup.html links to Steam help for finding a profile URL + privacy settings', () => {
    expect(LOOKUP_HTML).toContain('help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC');
    expect(LOOKUP_HTML).toContain('steamcommunity.com/my/edit/settings');
  });
  test('lookup main calls the public-steam-profile edge fn', () => {
    expect(LOOKUP_MAIN).toContain('/functions/v1/public-steam-profile');
  });
  test('lookup main reads ?steamId or ?input from URL for direct-link support', () => {
    expect(LOOKUP_MAIN).toContain("params.get('steamId')");
    expect(LOOKUP_MAIN).toContain("params.get('input')");
  });
  test('lookup main writes the resolved steamId back to the URL so a reload / share re-runs', () => {
    expect(LOOKUP_MAIN).toContain("nextUrl.searchParams.set('steamId', steamId)");
    expect(LOOKUP_MAIN).toContain('window.history.replaceState');
  });
  test('lookup main renders "Library at a glance" via the shared computeLibraryTierCounts', () => {
    expect(LOOKUP_MAIN).toContain('computeLibraryTierCounts');
    expect(LOOKUP_MAIN).toContain('Library at a glance');
  });
  test('lookup main shows the private-profile notice when isPublic=false', () => {
    expect(LOOKUP_MAIN).toContain('privateEl');
    expect(LOOKUP_MAIN).toMatch(/!profile\?\.isPublic\s*\|\|\s*gameCount\s*===\s*0/);
  });
});

describe('deploy plumbing', () => {
  test('lookup files are on the gh-pages manifest', () => {
    for (const f of ['lookup.html', 'js/lookup/main.js', 'css/lookup/lookup.css']) {
      expect(MANIFEST).toContain(f);
    }
  });
  test('topbar nav gets the "Look up a Profile" entry on both desktop and mobile', () => {
    expect(TOPBAR).toContain('href="lookup.html"');
    expect(TOPBAR).toContain('id="nav-lookup"');
    expect(TOPBAR).toContain('id="mobile-lookup"');
  });
});

describe('sign-in hint spread across the site', () => {
  test('auth.html points to lookup as the no-signin alternative', () => {
    const AUTH = read('auth.html');
    expect(AUTH).toContain('auth-no-signin-hint');
    expect(AUTH).toContain('href="lookup.html"');
  });
  test('profile.html signed-out state offers the lookup path', () => {
    const PROFILE = read('profile.html');
    expect(PROFILE).toContain('profile-unsigned-hint');
    expect(PROFILE).toContain('href="lookup.html"');
  });
  test('submit.html auth-gate hint offers the lookup path', () => {
    const SUBMIT = read('submit.html');
    expect(SUBMIT).toMatch(/auth-gate[\s\S]*href="lookup\.html"/);
  });
});
