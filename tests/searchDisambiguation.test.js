/**
 * Tests for window.__buildTitleOverrides defined in js/lib/topbar.js.
 * Verifies that same-name games (Prey 2006 vs Prey 2017, etc.) only get a
 * "(YEAR)" suffix when the title actually collides and the year is known.
 *
 * topbar.js is a classic-script IIFE that touches DOM. We pull just the helper
 * out by capturing the global assignment in a minimal jsdom-style window.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadHelper() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'lib', 'topbar.js'),
    'utf8'
  );
  // Pull the helper out by isolating the function declaration and the global
  // assignment. The full IIFE touches DOM, so we extract just what we test.
  const start = src.indexOf('function buildTitleOverrides');
  const end = src.indexOf('window.__buildTitleOverrides = buildTitleOverrides;');
  if (start === -1 || end === -1) {
    throw new Error('buildTitleOverrides not found in topbar.js -- update test extraction');
  }
  const snippet = src.slice(start, end) + 'window.__buildTitleOverrides = buildTitleOverrides;';
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  return sandbox.window.__buildTitleOverrides;
}

describe('buildTitleOverrides', () => {
  const buildTitleOverrides = loadHelper();

  test('returns empty map when titles are all unique', () => {
    const out = buildTitleOverrides([
      { title: 'Half-Life', releaseYear: 1998 },
      { title: 'Portal', releaseYear: 2007 },
    ]);
    expect(out.size).toBe(0);
  });

  test('appends year to colliding titles when year is known', () => {
    const out = buildTitleOverrides([
      { title: 'Prey', releaseYear: 2006 },
      { title: 'Prey', releaseYear: 2017 },
    ]);
    expect(out.get(0)).toBe('Prey (2006)');
    expect(out.get(1)).toBe('Prey (2017)');
  });

  test('only overrides entries that have a year on collision', () => {
    const out = buildTitleOverrides([
      { title: 'Prey', releaseYear: 2017 },
      { title: 'Prey', releaseYear: null },
    ]);
    expect(out.get(0)).toBe('Prey (2017)');
    expect(out.has(1)).toBe(false);
  });

  test('normalizes case and whitespace before grouping', () => {
    const out = buildTitleOverrides([
      { title: '  prey ', releaseYear: 2006 },
      { title: 'PREY', releaseYear: 2017 },
    ]);
    expect(out.size).toBe(2);
  });

  test('non-colliding titles never get a year suffix even when year is known', () => {
    const out = buildTitleOverrides([
      { title: 'Half-Life', releaseYear: 1998 },
    ]);
    expect(out.size).toBe(0);
  });

  test('ignores entries with empty/missing title', () => {
    const out = buildTitleOverrides([
      { title: '', releaseYear: 2006 },
      { title: 'Prey', releaseYear: 2017 },
    ]);
    expect(out.size).toBe(0);
  });
});
