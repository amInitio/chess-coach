// Serves the Stockfish engine files (js + wasm) from Cache Storage first, so they are
// downloaded once and never expire after 10 minutes like normal HTTP-cached files.
// The page (src/engine.ts) fills this cache; keep the cache name in sync with it.
const CACHE = 'stockfish-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return;
  if (!url.pathname.includes('/stockfish/') || url.pathname.endsWith('.json')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  })());
});
