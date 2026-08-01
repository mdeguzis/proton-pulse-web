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
  test('exposes a _lookupTrend helper fed by the batch enrichment loader (#437)', () => {
    expect(HOME_JS).toMatch(/function _lookupTrend/);
    expect(HOME_JS).toMatch(/function _addEnrichmentRows/);
    expect(HOME_JS).toMatch(/async function _loadEnrichment/);
    // Trend comes from the API row's trend field now, not blob column 9.
    expect(HOME_JS).toMatch(/r\.trend === 'improving'/);
    expect(HOME_JS).not.toMatch(/function _buildTrendMap/);
  });

  test('every renderGameCard call in home.js passes a trend option', () => {
    const calls = HOME_JS.match(/renderGameCard\(\{[\s\S]*?\}\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/trend:/);
    }
  });

  test('enrichment is loaded from the shown appids before rendering (#437)', () => {
    // _loadEnrichment must run in the render flow so the first paint has arrows.
    expect(HOME_JS).toMatch(/await _loadEnrichment\(\[/);
    // The full-blob loader is gone.
    expect(HOME_JS).not.toMatch(/loadSearchIndex\(\)/);
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
