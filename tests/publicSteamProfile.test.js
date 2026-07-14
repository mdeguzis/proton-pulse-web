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
      'js/shared/lookup-storage.js',
      'js/shared/profile-lookup-inline.js',
      'css/lookup/lookup.css',
      'css/shared/lookup-inline.css',
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
  test('auth.html offers the no-signin path via the inline mount (replaces the old hint link)', () => {
    // Post-#323 followup: the auth-no-signin-hint <p> link is gone;
    // the inline Library panel mounts as a peer of the auth-card and
    // renders its own "View full library breakdown" link back to /lookup.
    const AUTH = read('auth.html');
    expect(AUTH).toContain('id="profile-lookup-inline-mount"');
  });
  test('profile.html signed-out state offers the lookup path', () => {
    // Post-#323 followup: the inline "Library" panel mounts under the
    // Login button, replacing the standalone hint link. The panel itself
    // renders a "View full library breakdown" link to lookup.html, so
    // the outbound path still exists -- it just comes from the shared
    // mount template rather than inline profile.html markup.
    const PROFILE = read('profile.html');
    expect(PROFILE).toContain('id="profile-lookup-inline-mount"');
  });
  test('submit.html auth-gate offers the no-signin path via the inline mount (replaces the old hint link)', () => {
    // Post-#323 followup: same as auth.html -- the outbound link inside
    // the auth-gate is replaced with the inline Library panel mounted
    // as a peer of the login card.
    const SUBMIT = read('submit.html');
    expect(SUBMIT).toMatch(/id="auth-gate"[\s\S]*id="profile-lookup-inline-mount"/);
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

  test('lookup main imports the localStorage keys from the shared module (no duplicated string literals)', () => {
    expect(LOOKUP_MAIN_STR).toMatch(/import \{ LS_INPUT_KEY, LS_STEAMID_KEY \} from '\.\.\/shared\/lookup-storage\.js/);
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
    // Key comes from the shared module; never duplicates the string literal.
    expect(SAVED_LOOKUP).toMatch(/import \{ LS_INPUT_KEY \} from ['"]\.\.\/\.\.\/shared\/lookup-storage\.js/);
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

  test('home.js hides the sign-in callout when a saved lookup exists (no nag)', () => {
    // The "Sign in to get started" callout is a nag if the user already has
    // a saved lookup providing the same value. Regressing this makes the
    // callout appear alongside a fully populated library chart.
    expect(HOME_JS).toMatch(/_callout\.hidden = hasSavedLookup\(\)/);
  });

  test('home-library-chart renders for signed-out visitors when a saved lookup exists', () => {
    // The chart used to bail with `mountEl.innerHTML = ''` for any
    // signed-out visitor. It must now check hasSavedLookup and swap the
    // signed-in fetch for the saved-lookup helper instead of returning
    // blank -- otherwise the "at a glance" chart never appears on the
    // browse view for anonymous visitors with a saved profile.
    const CHART = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'app', 'components', 'home-library-chart.js'),
      'utf8',
    );
    expect(CHART).toContain('hasSavedLookup');
    expect(CHART).toContain('getSavedLookupLibraryAppIds');
    expect(CHART).toContain('getSavedLookupWishlistAppIds');
    expect(CHART).toMatch(/useSavedLookup\s*=\s*true/);
    // The old "signed-out -> blank" early return is gated on
    // !hasSavedLookup so it only fires when there is truly nothing to show.
    expect(CHART).toMatch(/if \(!savedMod\.hasSavedLookup\(\)\)[\s\S]{0,80}mountEl\.innerHTML = ''/);
  });
});

describe('#323 followup: inline Library panel under Login button', () => {
  const PROFILE_HTML = read('profile.html');
  const PROFILE_MAIN = read('js/profile/main.js');
  const INLINE = read('js/shared/profile-lookup-inline.js');
  const STORAGE = read('js/shared/lookup-storage.js');
  const INLINE_CSS = read('css/shared/lookup-inline.css');

  test('profile.html mount is a peer of the login card, not nested inside it', () => {
    // The mount container must sit as a SIBLING of .profile-unsigned, not
    // as a child. Two cards on the page read as two distinct alternatives;
    // nesting the panel inside the login card makes it look like "part of
    // the login flow".
    const unsignedBlock = PROFILE_HTML.match(/<div class="profile-unsigned">[\s\S]*?<\/div>/);
    expect(unsignedBlock).toBeTruthy();
    expect(unsignedBlock[0]).not.toContain('profile-lookup-inline-mount');
    // But the mount container IS still inside the outer signed-out wrapper.
    const signedOut = PROFILE_HTML.match(/id="profile-signed-out"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
    expect(signedOut[0]).toContain('id="profile-lookup-inline-mount"');
    // Order: login card first, then the mount below it.
    const btnPos = signedOut[0].indexOf('class="profile-unsigned"');
    const mountPos = signedOut[0].indexOf('id="profile-lookup-inline-mount"');
    expect(mountPos).toBeGreaterThan(btnPos);
  });

  test('profile.html includes the shared inline-lookup stylesheet', () => {
    expect(PROFILE_HTML).toMatch(/href="css\/shared\/lookup-inline\.css/);
  });

  test('profile main mounts the inline lookup on showSignedOut', () => {
    expect(PROFILE_MAIN).toContain('mountInlineProfileLookup');
    expect(PROFILE_MAIN).toContain("'profile-lookup-inline-mount'");
    expect(PROFILE_MAIN).toMatch(/import\(.*profile-lookup-inline\.js/);
  });

  test('inline mount uses the shared localStorage keys (never inlines the key string)', () => {
    expect(INLINE).toMatch(/import \{[^}]*readSavedLookup[^}]*writeSavedLookup[^}]*clearSavedLookup[^}]*\} from ['"]\.\/lookup-storage\.js/);
    expect(INLINE).not.toContain("'pp:lookup-profile-input'");
    expect(INLINE).not.toContain("'pp:lookup-profile-steamid'");
  });

  test('inline mount hits the public-steam-profile edge fn and persists the resolved SteamID', () => {
    expect(INLINE).toContain('/functions/v1/public-steam-profile');
    expect(INLINE).toMatch(/writeSavedLookup\(input, body\.steamId/);
  });

  test('inline mount keeps the Steam help doc + privacy settings links prominent', () => {
    expect(INLINE).toContain('help.steampowered.com/en/faqs/view/2816-BE67-5B69-0FEC');
    expect(INLINE).toContain('steamcommunity.com/my/edit/settings');
  });

  test('inline mount offers a "View full library breakdown" link back to /lookup', () => {
    expect(INLINE).toMatch(/href="lookup\.html"/);
  });

  test('inline mount Clear button wipes the saved lookup', () => {
    expect(INLINE).toMatch(/clearSavedLookup\(\)/);
  });

  test('shared lookup-storage module exports the three helpers other modules use', () => {
    expect(STORAGE).toMatch(/export function readSavedLookup/);
    expect(STORAGE).toMatch(/export function writeSavedLookup/);
    expect(STORAGE).toMatch(/export function clearSavedLookup/);
    expect(STORAGE).toMatch(/export const LS_INPUT_KEY = 'pp:lookup-profile-input'/);
    expect(STORAGE).toMatch(/export const LS_STEAMID_KEY = 'pp:lookup-profile-steamid'/);
  });

  test('inline CSS ships all element classes the mount renders', () => {
    for (const cls of ['.profile-lookup-inline', '.pli-title', '.pli-copy', '.pli-input', '.pli-save', '.pli-examples', '.pli-hint', '.pli-status', '.pli-actions', '.pli-clear']) {
      expect(INLINE_CSS).toContain(cls);
    }
  });

  test('auth.html mounts the inline panel as a peer of the auth-card', () => {
    const AUTH = read('auth.html');
    // Mount container sits OUTSIDE the <main class="auth-card">, not inside.
    expect(AUTH).toMatch(/<\/main>\s*[\s\S]{0,200}<div id="profile-lookup-inline-mount"/);
    // Stylesheet is included so the panel actually renders.
    expect(AUTH).toMatch(/href="css\/shared\/lookup-inline\.css/);
    // Bootstrap script imports the mount fn.
    expect(AUTH).toMatch(/import \{ mountInlineProfileLookup \} from ['"]\.\/js\/shared\/profile-lookup-inline\.js/);
  });

  test('auth.css sizes the mount to match the auth-card width so they stack cleanly', () => {
    const AUTH_CSS = read('css/auth/auth.css');
    expect(AUTH_CSS).toContain('.auth-lookup-mount');
    expect(AUTH_CSS).toMatch(/width:\s*min\(100%,\s*760px\)/);
  });

  test('submit.html auth-gate mounts the inline panel as a peer of the login card', () => {
    const SUBMIT = read('submit.html');
    // auth-gate wraps two peer divs: the login card + the mount container.
    const gate = SUBMIT.match(/id="auth-gate"[\s\S]*?<\/div>\s*<\/div>/);
    expect(gate).toBeTruthy();
    expect(gate[0]).toContain('id="profile-lookup-inline-mount"');
    // Stylesheet is included.
    expect(SUBMIT).toMatch(/href="css\/shared\/lookup-inline\.css/);
  });

  test('submit main mounts the inline panel when the auth-gate becomes visible', () => {
    const SUBMIT_MAIN = read('js/submit/main.js');
    expect(SUBMIT_MAIN).toContain("mountInlineProfileLookup('profile-lookup-inline-mount')");
    expect(SUBMIT_MAIN).toMatch(/import\(.*profile-lookup-inline\.js/);
  });
});
