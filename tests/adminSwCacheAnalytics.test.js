const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'api', 'analytics.js'), 'utf8');
const compSrc = fs.readFileSync(path.join(ROOT, 'js', 'admin', 'components', 'analytics.js'), 'utf8');

describe('admin analytics -- service worker image cache', () => {
  test('api fetches sw_cache events from site_events and attaches them', () => {
    expect(apiSrc).toContain('async function fetchSwCacheStats(session, daysBack)');
    expect(apiSrc).toContain('event_type=eq.sw_cache');
    expect(apiSrc).toContain('data.sw_cache = await fetchSwCacheStats(session, daysBack)');
  });

  test('api aggregates hits/misses into an overall hit rate and a daily series', () => {
    expect(apiSrc).toContain('hits += h; misses += ms;');
    expect(apiSrc).toContain('hit_rate: total ? Math.round((hits / total) * 100) : 0');
    expect(apiSrc).toContain('by_day:');
  });

  test('component renders an image cache card, with an empty state', () => {
    expect(compSrc).toContain('function renderSwCache(sw)');
    expect(compSrc).toContain('Image cache hit rate');
    expect(compSrc).toContain('No service worker cache data yet.');
    expect(compSrc).toContain('${renderSwCache(data.sw_cache)}');
  });
});
