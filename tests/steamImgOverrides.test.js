/**
 * Source-shape pins for the admin box art override wiring in steam-img.js.
 *
 * Overrides live in the box_art_overrides Supabase table and take effect
 * on the frontend without waiting for a pipeline rerun. steam-img.js
 * fetches the table on load and applies overrides both to the initial
 * DOM and to any img[data-appid] added later (search results, load-more,
 * tab switches).
 *
 * These tests pin the module contract so future refactors can't silently
 * drop the override lookup or the mutation observer.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app', 'lib', 'steam-img.js'),
  'utf8',
);

describe('steam-img override wiring', () => {
  test('fetches box_art_overrides via anon-key REST', () => {
    expect(SRC).toContain('/rest/v1/box_art_overrides');
    expect(SRC).toContain('SUPABASE_ANON_KEY');
  });

  test('caches the map in sessionStorage with a TTL', () => {
    // TTL prevents stale overrides from lingering forever; sessionStorage
    // scopes to the tab so admin edits show up on other tabs' next load.
    expect(SRC).toContain('sessionStorage');
    expect(SRC).toMatch(/_OVERRIDES_CACHE_KEY|boxart_overrides_v1/);
    expect(SRC).toMatch(/_OVERRIDES_TTL_MS/);
  });

  test('applies overrides to img[data-appid] in the initial DOM', () => {
    // Must query the whole document -- not just a component root -- so
    // every card and header image gets covered on first paint.
    expect(SRC).toMatch(/querySelectorAll\('img\[data-appid\]'\)/);
    expect(SRC).toMatch(/img\.src\s*=\s*overrideUrl/);
  });

  test('watches for dynamically-inserted img[data-appid] via MutationObserver', () => {
    // Search results, load-more, and tab switches insert cards after
    // the initial scan; without an observer those never get overridden.
    expect(SRC).toContain('new MutationObserver');
    expect(SRC).toMatch(/childList:\s*true/);
    expect(SRC).toMatch(/subtree:\s*true/);
  });

  test('override map is idempotent (skip when src already matches)', () => {
    // Applying twice in a row must not thrash the network with re-requests.
    expect(SRC).toMatch(/if\s*\(img\.src\s*!==\s*overrideUrl\)/);
  });
});
