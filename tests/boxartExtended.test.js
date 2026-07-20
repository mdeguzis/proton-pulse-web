/**
 * Box Art Manager must find long-tail Steam games (#363). Titles like Cat Chess
 * (4163030) live only in the extended index, so without it an admin searching the
 * Box Art Manager gets "0 games match" and cannot fix their art. The manager now
 * loads the extended index and folds matching games in WHEN SEARCHING (deduped,
 * never all 144k while browsing).
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'admin', 'components', 'boxart.js'),
  'utf8',
);

describe('Box Art Manager surfaces extended-index games on search (#363)', () => {
  test('loads the extended Steam index alongside the main index', () => {
    expect(SRC).toMatch(/dataUrl\('search-index-steam-extended\.json'\)/);
    expect(SRC).toMatch(/const extendedIndex\s*=/);
    // and passes it through the cache
    expect(SRC).toMatch(/_cache = \{[^}]*extendedIndex/);
  });

  test('the detail view (?boxart=<appId>) falls back to the extended index', () => {
    const start = SRC.indexOf('export async function renderBoxartAdminDetail');
    const end = SRC.indexOf('not found in the search index', start);
    const fn = SRC.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // searchRow tries the main index, then the extended index.
    expect(fn).toMatch(/indexes\.searchIndex[\s\S]*indexes\.extendedIndex/);
  });

  test('_buildRows folds in the extended index only when a query is present, deduped', () => {
    const start = SRC.indexOf('function _buildRows');
    const end = SRC.indexOf('\n}', start);
    const fn = SRC.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // destructures extendedIndex
    expect(fn).toMatch(/function _buildRows\(\{[^}]*extendedIndex/);
    // dedup guard
    expect(fn).toMatch(/seen\.has\(appId\)/);
    // only iterates the extended index when there is a text query
    expect(fn).toMatch(/if \(q && Array\.isArray\(extendedIndex\)\)/);
  });
});
