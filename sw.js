// Service worker: cache-first for game cover images so the grid paints instantly
// on repeat visits. Steam, GOG, and Epic covers come from third-party CDNs, which
// on a cold cache is dozens of round trips and a slow first paint, worst on flaky
// mobile networks. We only touch image GETs. Everything else (HTML, JS, CSS, JSON)
// goes straight to the network so the ?v= cache-bust stays the single source of
// truth for site assets and nothing goes stale.

const CACHE = 'pp-img-cache-v1';
const MAX_ENTRIES = 300;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Keep the image cache bounded. cache.keys() returns entries in insertion order,
// so deleting from the front trims the oldest (FIFO) once we exceed the cap.
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only images, only GET. Let the network handle everything else untouched.
  if (req.method !== 'GET' || req.destination !== 'image') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // Cache ok responses and opaque ones. Cards load covers no-cors, so the
      // Steam/GOG/Epic CDN responses come back opaque (status 0, type opaque);
      // they are still cacheable and serveable to an <img>.
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {});
      }
      return res;
    } catch (e) {
      // Offline or network blip: serve any cached copy, otherwise return an
      // error so the existing <img> onerror fallback chain (cloudflare ->
      // game-images.json -> hide) still runs.
      return (await cache.match(req)) || Response.error();
    }
  })());
});
