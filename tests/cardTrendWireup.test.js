/**
 * Static wire-up guard for the trend-arrow feature.
 *
 * home.js and index/main.js both pull the trend column out of search-index and
 * forward it into every renderGameCard call. If someone edits either file and
 * drops the forward, cards silently lose their arrows. These grep-level
 * assertions keep that from regressing without needing a full DOM harness.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const HOME_JS = read('js/app/components/home.js');
const INDEX_JS = read('js/index/main.js');

describe('home.js forwards trend into every card', () => {
  test('exposes a _lookupTrend / _buildTrendMap pair keyed off searchIndex', () => {
    expect(HOME_JS).toMatch(/function _lookupTrend/);
    expect(HOME_JS).toMatch(/function _buildTrendMap/);
    // The map must key off column 9 of search-index rows (see finalize.py).
    expect(HOME_JS).toMatch(/row\[9\]/);
  });

  test('every renderGameCard call in home.js passes a trend option', () => {
    const calls = HOME_JS.match(/renderGameCard\(\{[\s\S]*?\}\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/trend:/);
    }
  });

  test('trend map is built after loadSearchIndex resolves, before rendering', () => {
    // _buildTrendMap must appear after the Promise.all block that awaits
    // loadSearchIndex, otherwise the first paint has no arrows.
    const buildIdx = HOME_JS.indexOf('_buildTrendMap();');
    const loadIdx = HOME_JS.indexOf('loadSearchIndex()');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(loadIdx);
  });
});

describe('index/main.js (browse) forwards trend into pgCardHtml', () => {
  test('has a trend lookup helper backed by search-index column 9', () => {
    expect(INDEX_JS).toMatch(/function _lookupTrend/);
    expect(INDEX_JS).toMatch(/function _buildTrendMap/);
    expect(INDEX_JS).toMatch(/row\[9\]/);
  });

  test('pgCardHtml passes trend through to renderGameCard', () => {
    // Only one renderGameCard call lives on the browse page. Just check it
    // carries the trend field.
    const match = INDEX_JS.match(/renderGameCard\(\{[\s\S]*?\}\)/);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/trend: _lookupTrend/);
  });

  test('search-index is loaded in parallel with most_played so first paint has arrows', () => {
    // Must live inside the Promise.all with the most_played fetch; otherwise
    // Steam-only mode paints without arrows and the user gets a flash.
    expect(INDEX_JS).toMatch(/Promise\.all\(\[[\s\S]*?loadSearchIndex\(\)[\s\S]*?\]\)/);
  });
});
