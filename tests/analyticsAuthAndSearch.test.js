/**
 * Source-shape tests for #143 piecesthat live outside js/lib/analytics.js:
 *
 *   - supabase-client.js: auth_success / auth_failure events around setSession
 *   - search.js: search_query event in renderSearchPage + search_result_click
 *     on result card clicks
 *
 * Pinning the call sites here so a future refactor that drops the ppTrack
 * call (or fires it without the right metadata shape) breaks loudly.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUPABASE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'lib', 'supabase-client.js'), 'utf8');
const SEARCH_SRC   = fs.readFileSync(path.join(ROOT, 'js', 'app', 'components', 'search.js'), 'utf8');

describe('auth funnel events (#143)', () => {
  test("setSession success fires ppTrack('auth_success')", () => {
    // The success branch comes right after setSession resolves without an
    // error. Track AFTER the success log so the order of operations is
    // visible at runtime.
    expect(SUPABASE_SRC).toContain("window.ppTrack('auth_success', {})");
  });

  test("setSession failure fires ppTrack('auth_failure') with truncated reason", () => {
    expect(SUPABASE_SRC).toContain("window.ppTrack('auth_failure'");
    // Bound the reason payload so a malicious or oversized error message
    // cannot bloat site_events rows.
    expect(SUPABASE_SRC).toMatch(/error\.message.*setSession error.*slice\(0,\s*200\)/);
  });

  test('auth track calls are guarded by typeof window.ppTrack === function', () => {
    // If analytics.js failed to load (rare) we must not throw inside the
    // auth callback or the redirect breaks.
    const block = SUPABASE_SRC.slice(
      SUPABASE_SRC.indexOf('const { error } = await _sb.auth.setSession'),
      SUPABASE_SRC.indexOf("// Redirect to the page the user was on before login")
    );
    const guardCount = (block.match(/typeof window\.ppTrack === 'function'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(2);
  });
});

describe('search events (#143)', () => {
  test("renderSearchPage fires ppTrack('search_query') for non-empty queries", () => {
    expect(SEARCH_SRC).toContain("window.ppTrack('search_query'");
    expect(SEARCH_SRC).toContain("source: 'app'");
    // Query is trimmed and bounded to keep the payload tame.
    expect(SEARCH_SRC).toContain('q.slice(0, 120)');
  });

  test('search_query call guarded by typeof window.ppTrack === function', () => {
    // ppTrack may not exist on first paint of submit.html etc. Guard the
    // call so a missing analytics.js never breaks renderSearchPage.
    expect(SEARCH_SRC).toMatch(/typeof window\.ppTrack === 'function'[\s\S]{0,200}'search_query'/);
  });

  test('skips search_query when query is empty (renderSearchPage with no q)', () => {
    // The track call is wrapped in `if (q && ...)` so an empty render
    // does not pollute site_events with empty-query noise.
    expect(SEARCH_SRC).toMatch(/if \(q && typeof window\.ppTrack === 'function'\)[\s\S]{0,200}'search_query'/);
  });

  test('result card click delegates fire search_result_click with group label', () => {
    expect(SEARCH_SRC).toContain("window.ppTrack('search_result_click'");
    expect(SEARCH_SRC).toContain('appId: clickedId');
    expect(SEARCH_SRC).toContain('group,');
    expect(SEARCH_SRC).toContain('position,');
  });

  test('group is one of pulse / primary / extended', () => {
    // Pin the group taxonomy. If a new group is added, this test should
    // fail and the new value should be explicitly added here so admin
    // charts continue to break the source apart cleanly.
    const block = SEARCH_SRC.slice(
      SEARCH_SRC.indexOf("let group = 'extended'"),
      SEARCH_SRC.indexOf("'search_result_click'")
    );
    expect(block).toContain("group = 'extended'");
    expect(block).toContain("group = 'pulse'");
    expect(block).toContain("group = 'primary'");
  });

  test('click delegate uses a single listener on the content root', () => {
    // Don't attach N listeners. With ~48 results that would pile up fast.
    expect(SEARCH_SRC).toContain("el.addEventListener('click'");
  });
});
