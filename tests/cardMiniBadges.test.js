/**
 * Game-details tag row + browse-card cleanup tests (#266 refinement).
 *
 * Covers:
 *  1. js/lib/card-badges.js: KNOWN_BADGES + computeBadgesForAppId shape
 *     (site-pref layer has been removed).
 *  2. renderGameCard integration: no miniBadges prop; the sub line is
 *     only rendered when supplied.
 *  3. home.js source: no report-count sub, no card-badges import.
 *  4. game-page.js source: unified tag row under the artwork with OS
 *     chips + user-context tags, gated on signed-in only.
 *  5. options.html + main.js: the "Game page tags" pref is gone (moved
 *     to always-on because the tags live on a details page now).
 */
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./_esm-vm.js');

// ---------- Part 1: card-badges.js ---------------------------------------

function loadCardBadges() {
  const ctx = loadEsm(['js/lib/card-badges.js'], { console: { debug: () => {} } });
  return ctx;
}

describe('card-badges.js: computeBadgesForAppId', () => {
  test('returns wishlist tag when the appId is in the wishlist Set', () => {
    const { computeBadgesForAppId } = loadCardBadges();
    const tags = computeBadgesForAppId(570, {
      wishlistAppIds: new Set([570]),
      libraryAppIds: new Set(),
      signedIn: true,
    });
    expect(tags.map((b) => b.key)).toEqual(['wishlist']);
    expect(tags[0].label).toBe('On wishlist');
    expect(tags[0].color).toBe('#66c0f4');
  });

  test('returns library tag when the appId is in the library Set', () => {
    const { computeBadgesForAppId } = loadCardBadges();
    const tags = computeBadgesForAppId(440, {
      wishlistAppIds: new Set(),
      libraryAppIds: new Set([440]),
      signedIn: true,
    });
    expect(tags.map((b) => b.key)).toEqual(['library']);
  });

  test('returns both when the appId is in both Sets (dev/testing edge case)', () => {
    const { computeBadgesForAppId } = loadCardBadges();
    const tags = computeBadgesForAppId(730, {
      wishlistAppIds: new Set([730]),
      libraryAppIds: new Set([730]),
      signedIn: true,
    });
    expect(tags.map((b) => b.key).sort()).toEqual(['library', 'wishlist']);
  });

  test('signed-out short-circuits to empty regardless of data', () => {
    const { computeBadgesForAppId } = loadCardBadges();
    const tags = computeBadgesForAppId(570, {
      wishlistAppIds: new Set([570]),
      libraryAppIds: new Set([570]),
      signedIn: false,
    });
    expect(tags).toEqual([]);
  });

  test('appId not in any Set returns empty array', () => {
    const { computeBadgesForAppId } = loadCardBadges();
    const tags = computeBadgesForAppId(999999, {
      wishlistAppIds: new Set([1, 2, 3]),
      libraryAppIds: new Set([10, 20]),
      signedIn: true,
    });
    expect(tags).toEqual([]);
  });

  test('KNOWN_BADGES keeps the wishlist-then-library order for consistent rendering', () => {
    const { KNOWN_BADGES } = loadCardBadges();
    expect(KNOWN_BADGES.map((b) => b.key)).toEqual(['wishlist', 'library']);
  });
});


// ---------- Part 2: renderGameCard integration --------------------------

const CARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'lib', 'card.js'),
  'utf8',
);

describe('renderGameCard: browse cards no longer carry a badges row', () => {
  test('signature does not accept miniBadges (removed with the browse-page badges)', () => {
    expect(CARD_SRC).not.toMatch(/miniBadges/);
  });

  test('sub is only rendered when non-empty (empty string = no sub line)', () => {
    expect(CARD_SRC).toContain('const subHtml = sub ?');
    expect(CARD_SRC).toContain('${subHtml}</div>');
  });
});


// ---------- Part 3: home.js source --------------------------------------

const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'home.js'),
  'utf8',
);

describe('home.js: drops the report-count sub AND the miniBadges row', () => {
  test('_recentCardHtml passes empty sub and does NOT pass miniBadges', () => {
    expect(HOME_SRC).toMatch(/function _recentCardHtml[\s\S]{0,800}sub: ''/);
    const recentBody = HOME_SRC.match(/function _recentCardHtml[\s\S]{0,800}\}/);
    expect(recentBody[0]).not.toContain('miniBadges');
  });

  test('_popularItemHtml passes empty sub and does NOT pass miniBadges', () => {
    expect(HOME_SRC).toMatch(/function _popularItemHtml[\s\S]{0,900}sub: ''/);
    const popularBody = HOME_SRC.match(/function _popularItemHtml[\s\S]{0,900}\}/);
    expect(popularBody[0]).not.toContain('miniBadges');
  });

  test('home.js does not import card-badges (that lives on the details page now)', () => {
    expect(HOME_SRC).not.toMatch(/from '\.\.\/\.\.\/lib\/card-badges\.js/);
  });
});


// ---------- Part 4: game-page.js -- unified tag row --------------------

const GAME_PAGE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'components', 'game-page.js'),
  'utf8',
);

describe('game-page.js: unified tag row under the artwork', () => {
  test('imports only computeBadgesForAppId (getCardBadgePrefs is gone)', () => {
    expect(GAME_PAGE_SRC).toMatch(/from '\.\.\/\.\.\/lib\/card-badges\.js/);
    expect(GAME_PAGE_SRC).toContain('computeBadgesForAppId');
    expect(GAME_PAGE_SRC).not.toContain('getCardBadgePrefs');
    expect(GAME_PAGE_SRC).toContain('getMyLibraryAppIds');
    expect(GAME_PAGE_SRC).toContain('getMyWishlistAppIds');
  });

  test('markup has .game-header-art-tags wrapping the OS strip + user tags', () => {
    expect(GAME_PAGE_SRC).toContain('class="game-header-art-tags"');
    expect(GAME_PAGE_SRC).toContain('id="game-user-tags"');
    const artColMatch = GAME_PAGE_SRC.match(/class="game-header-art-col"[\s\S]{0,4000}game-header-art-tags/);
    expect(artColMatch).not.toBeNull();
  });

  test('user tags use .game-tag + .game-tag--user; OS chips use .game-tag + .game-os-chip', () => {
    expect(GAME_PAGE_SRC).toMatch(/class="game-tag game-tag--user"/);
    expect(GAME_PAGE_SRC).toMatch(/class="game-tag game-os-chip"/);
  });

  test('tag-row filler returns early when the user is signed out', () => {
    expect(GAME_PAGE_SRC).toMatch(/if \(!signedIn\) return;/);
  });
});


// ---------- Part 5: options.html + main.js -- pref removed --------------

const OPTIONS_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'options.html'),
  'utf8',
);
const OPTIONS_MAIN = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'options', 'main.js'),
  'utf8',
);

describe('options.html + main.js: card-badges pref is gone', () => {
  test('markup no longer has the checkbox group', () => {
    expect(OPTIONS_HTML).not.toContain('id="opt-card-badges"');
    expect(OPTIONS_HTML).not.toContain('data-badge-key');
    expect(OPTIONS_HTML).not.toContain('Game page tags');
  });

  test('main.js does not import from card-badges anymore', () => {
    expect(OPTIONS_MAIN).not.toMatch(/from '\.\.\/lib\/card-badges\.js/);
    expect(OPTIONS_MAIN).not.toContain('getCardBadgePrefs');
    expect(OPTIONS_MAIN).not.toContain('setCardBadgePref');
  });

  test('reset still clears the legacy pp:card-badges key so stale storage is scrubbed', () => {
    // Kept intentionally so a device that toggled the old pref back off
    // clears the localStorage entry on next reset. New devices never write
    // it, so a fresh install has nothing to clear.
    expect(OPTIONS_MAIN).toMatch(/RESET_KEYS\s*=\s*\[[^\]]*'pp:card-badges'/);
  });
});
