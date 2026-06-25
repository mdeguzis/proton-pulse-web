const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const topbarSrc = fs.readFileSync(path.join(ROOT, 'js', 'lib', 'topbar.js'), 'utf8');
const manifest = fs.readFileSync(path.join(ROOT, 'gh-pages-manifest.txt'), 'utf8');

describe('service worker -- image cache', () => {
  test('uses a versioned cache name and a bounded entry cap', () => {
    expect(swSrc).toMatch(/const CACHE = 'pp-img-cache-v\d+'/);
    expect(swSrc).toContain('const MAX_ENTRIES =');
  });

  test('activates promptly and cleans up old cache versions', () => {
    expect(swSrc).toContain('self.skipWaiting()');
    expect(swSrc).toContain('self.clients.claim()');
    expect(swSrc).toContain('keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))');
  });

  test('only intercepts image GET requests, lets everything else pass', () => {
    expect(swSrc).toContain("if (req.method !== 'GET' || req.destination !== 'image') return;");
  });

  test('cache-first: serves a cache hit, otherwise fetches and stores', () => {
    expect(swSrc).toContain('const hit = await cache.match(req);');
    expect(swSrc).toContain('if (hit) { stats.hits++; return hit; }');
    // caches ok and opaque (cross-origin no-cors covers) responses
    expect(swSrc).toContain('res.ok || res.type === \'opaque\'');
    expect(swSrc).toContain('cache.put(req, res.clone())');
  });

  test('trims the cache to the cap (FIFO) so it does not grow without bound', () => {
    expect(swSrc).toContain('async function trim(cache)');
    expect(swSrc).toContain('if (keys.length <= MAX_ENTRIES) return;');
    expect(swSrc).toContain('await cache.delete(keys[i]);');
  });

  test('network failure falls back to cache then a real error for the img onerror chain', () => {
    expect(swSrc).toContain('(await cache.match(req)) || Response.error()');
  });
});

describe('service worker -- registration and deploy wiring', () => {
  test('topbar registers sw.js behind a feature check', () => {
    expect(topbarSrc).toContain("if ('serviceWorker' in navigator)");
    expect(topbarSrc).toContain("navigator.serviceWorker.register('sw.js')");
  });

  test('sw.js is listed in the gh-pages deploy manifest', () => {
    const files = manifest.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(files).toContain('sw.js');
  });
});

describe('service worker -- cache analytics', () => {
  test('sw counts hits and misses', () => {
    expect(swSrc).toContain('const stats = { hits: 0, misses: 0 }');
    expect(swSrc).toContain('if (hit) { stats.hits++; return hit; }');
    expect(swSrc).toContain('stats.misses++;');
  });

  test('sw answers a stats query and resets counters so each report is a delta', () => {
    expect(swSrc).toContain("event.data.type !== 'pp-sw-stats'");
    expect(swSrc).toContain('event.ports[0].postMessage(snapshot)');
    expect(swSrc).toContain('stats.hits = 0;');
    expect(swSrc).toContain('stats.misses = 0;');
  });

  test('topbar reports one sw_cache event via ppTrack when the page hides', () => {
    expect(topbarSrc).toContain("document.visibilityState === 'hidden'");
    expect(topbarSrc).toContain("sw.postMessage({ type: 'pp-sw-stats' }, [ch.port2])");
    expect(topbarSrc).toContain("window.ppTrack('sw_cache'");
    // guard against reporting empty deltas
    expect(topbarSrc).toContain('if (!total) return;');
  });
});
