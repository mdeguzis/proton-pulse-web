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
  test('has a trend lookup helper backed by the batch API trend field (#437)', () => {
    expect(INDEX_JS).toMatch(/function _lookupTrend/);
    expect(INDEX_JS).toMatch(/function _addTrend/);
    // Trend now comes from the API row's trend field, not blob column 9.
    expect(INDEX_JS).toMatch(/_addTrend\(r\.appId, r\.trend\)/);
  });

  test('pgCardHtml passes trend through to renderGameCard', () => {
    // Only one renderGameCard call lives on the browse page. Just check it
    // carries the trend field.
    const match = INDEX_JS.match(/renderGameCard\(\{[\s\S]*?\}\)/);
    expect(match).not.toBeNull();
    expect(match[0]).toMatch(/trend: _lookupTrend/);
  });

  test('Steam trend is batched from most_played appids before first paint (#437)', () => {
    // Awaited after most_played resolves (its appids feed the batch), so the
    // first paint still has arrows in Steam-only mode without loading the blob.
    expect(INDEX_JS).toMatch(/await _loadSteamTrend\(games\.map\(g => g\.appId\)\)/);
    expect(INDEX_JS).not.toMatch(/loadSearchIndex/);
  });
});
