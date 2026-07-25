/**
 * #400: the Metadata modal must be store-aware. Steam ids walk the
 * appdetails path; gog:/epic:/pgwiki: ids render from client-held data
 * (their APIs cannot be reached from the browser -- Steam appdetails
 * cannot know those ids at all, and GOG/Epic CORS-lock their APIs).
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js/app/components/game-page.js'),
  'utf8',
);

describe('metadata modal store routing (#400)', () => {
  test('derives the store from the app id before any fetch', () => {
    expect(SRC).toMatch(/const storeType = appTypeFromAppId\(appId\);/);
  });

  test('non-Steam ids branch to the non-Steam renderer, never Steam appdetails', () => {
    expect(SRC).toMatch(/if \(storeType !== 'steam'\) \{\s*await _renderNonSteamMetadata\(modal, appId, storeType\);\s*return;/);
  });

  test('loading copy names the actual store, not always Steam', () => {
    expect(SRC).toContain('Loading ${esc(storeLabel(storeType))} metadata...');
    expect(SRC).not.toContain('Loading Steam metadata...');
  });

  test('pgwiki renders from pcgwiki-catalog.json with the CC attribution', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain("dataUrl('pcgwiki-catalog.json')");
    expect(fn).toContain('CC BY-NC-SA 3.0');
    // wiki_url is only trusted on the pcgamingwiki.com origin
    expect(fn).toMatch(/wiki_url.*startsWith\('https:\/\/www\.pcgamingwiki\.com\/'\)/);
  });

  test('pgwiki shows engine, developers, publishers, release year, OS chips', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    for (const bit of ["entry?.engine", "entry?.developers", "entry?.publishers", 'release_year', 'humanPCGamingWikiOs']) {
      expect(fn).toContain(bit);
    }
  });

  test('gog links to GOG DB by bare product id; epic falls back to store search', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain('https://www.gogdb.org/product/');
    expect(fn).toMatch(/replace\(\/\^\(gog\|epic\):\/, ''\)/);
    expect(fn).toContain('store.epicgames.com');
  });

  test('gog/epic honestly state why deep metadata is unavailable (CORS)', () => {
    const fn = SRC.slice(SRC.indexOf('async function _renderNonSteamMetadata'));
    expect(fn).toContain('CORS');
  });
});
