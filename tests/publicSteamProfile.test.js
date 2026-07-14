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
  test('uses ResolveVanityURL, GetOwnedGames, GetWishlist, and GetPlayerSummaries', () => {
    expect(EDGE).toContain('/ISteamUser/ResolveVanityURL/v1/');
    expect(EDGE).toContain('/IPlayerService/GetOwnedGames/v1/');
    expect(EDGE).toContain('/IWishlistService/GetWishlist/v1/');
    expect(EDGE).toContain('/ISteamUser/GetPlayerSummaries/v2/');
  });
  test('returns library + wishlist in the same envelope so the frontend renders both', () => {
    expect(EDGE).toContain('games: owned.games');
    expect(EDGE).toContain('wishlist: wishlist.items');
    expect(EDGE).toContain('wishlistCount: wishlist.count');
  });
  test('reads STEAM_API_KEY from env and returns 500 when missing', () => {
    expect(EDGE).toContain(`Deno.env.get("STEAM_API_KEY")`);
    expect(EDGE).toContain('missing_key');
  });
  test('never echoes the API key back to the caller', () => {
    // The api key may appear on `fetch` URLs (that is the whole point), but
    // it must never show up inside a json() response body.
    const jsonCalls = EDGE.match(/json\([\s\S]*?\)/g) || [];
    for (const call of jsonCalls) {
      expect(call).not.toMatch(/apiKey/);
    }
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
  test('lookup.html renders the form + result mounts (library + wishlist)', () => {
    expect(LOOKUP_HTML).toContain('id="lookup-form"');
    expect(LOOKUP_HTML).toContain('id="lookup-input"');
    expect(LOOKUP_HTML).toContain('id="lookup-chart-mount"');
    expect(LOOKUP_HTML).toContain('id="lookup-wishlist-mount"');
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
  test('lookup main renders "Library at a glance" and "Wishlist at a glance" via the shared computeLibraryTierCounts', () => {
    expect(LOOKUP_MAIN).toContain('computeLibraryTierCounts');
    expect(LOOKUP_MAIN).toContain('Library at a glance');
    expect(LOOKUP_MAIN).toContain('Wishlist at a glance');
    expect(LOOKUP_MAIN).toContain('wishlistMount');
  });
  test('lookup main treats library + wishlist visibility independently (private library can still show wishlist)', () => {
    // The wishlistCount branch is not gated by isPublic since Steam has a
    // separate wishlist visibility toggle. Regressing this makes the wishlist
    // chart silently vanish for anyone with a private library + public
    // wishlist, which is the exact case a public lookup is most useful for.
    expect(LOOKUP_MAIN).toMatch(/if \(wishlistCount > 0 && Array\.isArray\(wishlist\)\)/);
  });
  test('lookup main shows the private-profile notice when isPublic=false', () => {
    expect(LOOKUP_MAIN).toContain('privateEl');
    expect(LOOKUP_MAIN).toMatch(/!profile\?\.isPublic\s*\|\|\s*gameCount\s*===\s*0/);
  });
});

describe('deploy plumbing', () => {
  test('lookup files are on the gh-pages manifest', () => {
    for (const f of [
      'lookup.html',
      'js/lookup/main.js',
      'js/app/lib/saved-lookup.js',
      'css/lookup/lookup.css',
    ]) {
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

describe('#323 localStorage persistence + Save button + nav fallback', () => {
  const LOOKUP_HTML_STR = read('lookup.html');
  const LOOKUP_MAIN_STR = read('js/lookup/main.js');
  const SAVED_LOOKUP = read('js/app/lib/saved-lookup.js');
  const HOME_JS = read('js/app/components/home.js');

  test('lookup page has separate Look up + Save buttons, plus Clear', () => {
    expect(LOOKUP_HTML_STR).toContain('id="lookup-lookup"');
    expect(LOOKUP_HTML_STR).toContain('id="lookup-save"');
    expect(LOOKUP_HTML_STR).toContain('id="lookup-clear"');
    expect(LOOKUP_HTML_STR).toContain('id="lookup-saved-hint"');
  });

  test('lookup page ships an Examples bullet list matching ProtonDB layout', () => {
    expect(LOOKUP_HTML_STR).toMatch(/<ul class="lookup-examples">/);
    expect(LOOKUP_HTML_STR).toContain('steamcommunity.com/id/NAME-IN-URL');
    expect(LOOKUP_HTML_STR).toMatch(/76561198#+/);
  });

  test('lookup page keeps the Steam help doc link prominent', () => {
    expect(LOOKUP_HTML_STR).toContain('help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC');
  });

  test('lookup main defines the localStorage keys we share with the nav fallback', () => {
    expect(LOOKUP_MAIN_STR).toMatch(/LS_INPUT_KEY\s*=\s*'pp:lookup-profile-input'/);
    expect(LOOKUP_MAIN_STR).toMatch(/LS_STEAMID_KEY\s*=\s*'pp:lookup-profile-steamid'/);
  });

  test('lookup main persists only when the Save button is clicked (Look up is transient)', () => {
    // runLookup takes { persist } and only writes on persist=true.
    expect(LOOKUP_MAIN_STR).toMatch(/async function runLookup\(input, \{ persist = false \} = \{\}\)/);
    expect(LOOKUP_MAIN_STR).toMatch(/if \(persist\)\s*\{\s*writeSaved/);
    // Save button wires persist:true; Look up wires persist:false.
    expect(LOOKUP_MAIN_STR).toMatch(/saveBtn[\s\S]{0,200}submit\(\{ persist: true \}\)/);
    expect(LOOKUP_MAIN_STR).toMatch(/lookupBtn[\s\S]{0,200}submit\(\{ persist: false \}\)/);
  });

  test('lookup main autofills + auto-runs from localStorage on load, with URL param taking priority', () => {
    expect(LOOKUP_MAIN_STR).toContain('readSaved()');
    // URL preset wins; storage fills in when URL is empty.
    expect(LOOKUP_MAIN_STR).toMatch(/const preset = urlPreset \|\| saved\.input/);
  });

  test('lookup main Clear button wipes both localStorage keys and empties the input', () => {
    expect(LOOKUP_MAIN_STR).toMatch(/clearBtn\.addEventListener\('click'/);
    expect(LOOKUP_MAIN_STR).toMatch(/clearSaved\(\)/);
    expect(LOOKUP_MAIN_STR).toMatch(/removeItem\(LS_INPUT_KEY\)/);
    expect(LOOKUP_MAIN_STR).toMatch(/removeItem\(LS_STEAMID_KEY\)/);
  });

  test('saved-lookup helper caches the edge-fn response so library + wishlist share one round-trip', () => {
    expect(SAVED_LOOKUP).toContain('getSavedLookupLibraryAppIds');
    expect(SAVED_LOOKUP).toContain('getSavedLookupWishlistAppIds');
    expect(SAVED_LOOKUP).toContain('hasSavedLookup');
    expect(SAVED_LOOKUP).toMatch(/let _cache = null/);
    // Same localStorage key as /lookup writes.
    expect(SAVED_LOOKUP).toMatch(/LS_INPUT_KEY\s*=\s*'pp:lookup-profile-input'/);
    // Reads only -- never writes to localStorage.
    expect(SAVED_LOOKUP).not.toMatch(/localStorage\.setItem/);
  });

  test('home.js falls back to saved public lookup when getMyLibraryAppIds returns empty', () => {
    expect(HOME_JS).toContain('getSavedLookupLibraryAppIds');
    expect(HOME_JS).toContain('getSavedLookupWishlistAppIds');
    expect(HOME_JS).toContain('hasSavedLookup');
    // Fallback fires only when signed-in call returned empty AND a saved lookup exists.
    expect(HOME_JS).toMatch(/if \(isWishlist \? wishlistAppIds\.size === 0 : libraryAppIds\.size === 0\)[\s\S]{0,100}hasSavedLookup\(\)/);
  });
});
