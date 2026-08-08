// Service worker: cache-first for game cover images so the grid paints instantly
// on repeat visits. Steam, GOG, and Epic covers come from third-party CDNs, which
// on a cold cache is dozens of round trips and a slow first paint, worst on flaky
// mobile networks. We only touch image GETs. Everything else (HTML, JS, CSS, JSON)
// goes straight to the network so the ?v= cache-bust stays the single source of
// truth for site assets and nothing goes stale.
//
// Strategy: cache-first for instant paint, with stale-while-revalidate gated by a
// max-age. A cached image is always served immediately. If it is older than
// MAX_AGE_MS we also kick off a quiet background refetch to update the cache for
// next time. Fresh entries skip the refetch entirely, so we never re-download a
// cover we just fetched. Cover art rarely changes, so this keeps the paint instant
// while still healing a stale cover within a week.

const CACHE = 'pp-img-cache-v1';
const MAX_ENTRIES = 300;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Running counters since this worker spun up (or since the last stats read).
// The page reads + resets these on pagehide and reports one aggregate event,
// so we measure the cache hit rate without flooding analytics per image.
const stats = { hits: 0, misses: 0 };

self.addEventListener('install', () => self.skipWaiting());

// Stats query: reply with the current counters, then reset so each report from
// the page is a delta and we never double-count across reports in one session.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'pp-sw-stats') return;
  const snapshot = { hits: stats.hits, misses: stats.misses };
  stats.hits = 0;
  stats.misses = 0;
  if (event.ports && event.ports[0]) event.ports[0].postMessage(snapshot);
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Per-URL cache timestamps live in IndexedDB. Image responses are opaque
// (cross-origin, no-cors), so we cannot stamp a header on them; a side table
// keyed by request URL is the reliable way to track age for the max-age check.
const TS_DB = 'pp-sw-meta';
const TS_STORE = 'ts';
function _idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TS_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TS_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tsGet(key) {
  try {
    const db = await _idb();
    return await new Promise((resolve) => {
      const r = db.transaction(TS_STORE).objectStore(TS_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
  } catch (e) { return undefined; }
}
async function tsSet(key, val) {
  try {
    const db = await _idb();
    db.transaction(TS_STORE, 'readwrite').objectStore(TS_STORE).put(val, key);
  } catch (e) { /* timestamps are best-effort */ }
}

// Keep the image cache bounded. cache.keys() returns entries in insertion order,
// so deleting from the front trims the oldest (FIFO) once we exceed the cap.
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
    await cache.delete(keys[i]);
  }
}

// Fetch and store. Caches ok responses and opaque ones (cards load covers
// no-cors, so the Steam/GOG/Epic CDN responses come back opaque, status 0).
async function fetchAndCache(cache, req) {
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    await cache.put(req, res.clone());
    await tsSet(req.url, Date.now());
    await trim(cache);
  }
  return res;
}

// Background refresh for a stale-but-served entry. Swallows errors: we already
// served the cached copy, so a failed revalidate just means we try again later.
async function revalidate(cache, req) {
  try { await fetchAndCache(cache, req); } catch (e) { /* keep the stale copy */ }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only images, only GET. Let the network handle everything else untouched.
  if (req.method !== 'GET' || req.destination !== 'image') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);

    if (hit) {
      stats.hits++;
      // Stale-while-revalidate: serve instantly, refresh in the background only
      // if the cached copy is past max-age. Fresh entries skip the network.
      const cachedAt = await tsGet(req.url);
      if (!cachedAt || (Date.now() - cachedAt) > MAX_AGE_MS) {
        event.waitUntil(revalidate(cache, req));
      }
      return hit;
    }

    stats.misses++;
    try {
      return await fetchAndCache(cache, req);
    } catch (e) {
      // Offline or network blip: serve any cached copy, otherwise return an
      // error so the existing <img> onerror fallback chain (cloudflare ->
      // game-images.json -> hide) still runs.
      return (await cache.match(req)) || Response.error();
    }
  })());
});
