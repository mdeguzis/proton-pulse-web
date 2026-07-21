/**
 * Guards the boxart fallback chain for non-Steam entries (#375).
 *
 * loadSteamImg must attempt sources IN ORDER for gog: / epic: / pgwiki: ids:
 *   1. nonsteam-images.json (pipeline-published)
 *   2. same-title Steam CDN (search-index title match)
 *   3. SGDB via image-refetch edge fn (widescreen preferred, session cached)
 *   4. missing placeholder
 *
 * Anything else and a broken order silently falls through to "hidden" for
 * games that have covers, so this file exists to keep the chain honest.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/lib/steam-img.js'),
  'utf8',
);
const MANIFEST = fs.readFileSync(
  path.join(__dirname, '..', 'gh-pages-manifest.txt'),
  'utf8',
);

describe('non-Steam fallback chain', () => {
  test('gog / epic / pgwiki prefixes all enter the non-Steam branch', () => {
    // Missing any of these prefixes would ship a broken image on those cards.
    expect(SRC).toMatch(/id\.startsWith\('gog:'\)\s*\|\|\s*id\.startsWith\('epic:'\)\s*\|\|\s*id\.startsWith\('pgwiki:'\)/);
  });

  test('nonsteam-images.json is tried first', () => {
    // If a later source runs first, it wastes API quota.
    expect(SRC).toMatch(/_loadNonsteamImages\(\)[\s\S]{0,1200}_findSteamAppIdByMatchingTitle/);
  });

  test('steam-title-match runs before SGDB', () => {
    // Steam CDN is free and cached everywhere; SGDB costs an edge-fn round trip.
    expect(SRC).toMatch(/_findSteamAppIdByMatchingTitle[\s\S]{0,900}_lookupSgdbUrlByTitle/);
  });

  test('sgdb lookup runs before the hidden placeholder', () => {
    expect(SRC).toMatch(/_lookupSgdbUrlByTitle[\s\S]{0,600}_showMissing/);
  });

  test('every successful tier bumps a distinct route counter', () => {
    for (const route of ['nonsteam-images-json', 'steam-title-match', 'sgdb-title-match', 'hidden']) {
      expect(SRC).toContain(`_bumpRoute('${route}')`);
    }
  });

  test('route counters are pre-declared so a first-hit does not crash', () => {
    // The admin analytics panel reads window.__imgRouteCounts. A missing key
    // used to break the read (undefined + 1 = NaN) -- easier to pre-init.
    for (const route of ['nonsteam-images-json', 'steam-title-match', 'sgdb-title-match']) {
      expect(SRC).toContain(`'${route}': 0`);
    }
  });
});

describe('steam title match helper', () => {
  test('uses the shared normalizer from search-match.js', () => {
    // Titles differing only in punctuation ("Divinity: Original Sin" vs
    // "Divinity Original Sin") must match, which requires the same
    // normalizer both sides. Regression guard against forking it locally.
    expect(SRC).toMatch(/from ['"]\.\/search-match\.js/);
    expect(SRC).toContain('normalizeSearchable');
  });

  test('title match filters to bare-digit Steam ids', () => {
    // Without this, gog:foo could "match" itself and re-fetch its own broken URL.
    expect(SRC).toMatch(/\/\^\\d\+\$\/\.test\(rid\)/);
  });
});

describe('sgdb lookup', () => {
  test('POSTs to image-refetch with the sgdb_search source', () => {
    expect(SRC).toContain('/functions/v1/image-refetch');
    expect(SRC).toContain("source: 'sgdb_search'");
  });

  test('requests widescreen-preferred dimensions', () => {
    // 920x430 is SGDB's widescreen hero shape. 460x215 is Steam's header
    // (backup so we do not miss an entry that only has a Steam-shaped grid).
    expect(SRC).toMatch(/dimensions\s*=\s*['"]920x430,600x900,460x215['"]/);
  });

  test('session-caches the lookup so a browse grid does not fire N POSTs', () => {
    expect(SRC).toContain('_SGDB_CACHE_KEY');
    expect(SRC).toMatch(/sessionStorage\.setItem\(_SGDB_CACHE_KEY/);
  });

  test('caches a null miss so a game with no SGDB match does not retry every card render', () => {
    // Cache miss and API 4xx both hit `_sgdbCacheWrite(appId, null)`.
    expect(SRC).toMatch(/_sgdbCacheWrite\(appId,\s*null\)/);
  });

  test('does NOT cache network failures (transient -- next render retries)', () => {
    // The catch block must not cache before returning null.
    expect(SRC).toMatch(/console\.warn\('\[steam-img\] sgdb lookup network failure'[\s\S]{0,200}return null/);
  });
});

describe('manifest', () => {
  test('steam-img.js is deployed to gh-pages', () => {
    expect(MANIFEST).toContain('js/app/lib/steam-img.js');
  });

  test('search-match.js is deployed (steam-img now imports it)', () => {
    // Not listing search-match.js would silently 404 the module and hide
    // every non-Steam cover behind an import error, so the manifest check
    // is the load-bearing gate here.
    expect(MANIFEST).toContain('js/app/lib/search-match.js');
  });
});
