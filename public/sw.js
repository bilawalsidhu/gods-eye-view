/*
 * GEV service worker: caches the app shell only.
 *
 * Never cached: /api/*, /login, /logout, /mcp, anything non-GET, cross-origin
 * requests, redirects, non-200 responses and responses marked no-store. Map
 * tiles and live data always come from the network.
 */
const VERSION = 'gev-shell-v1';
const NEVER = [/^\/api\//, /^\/login$/, /^\/logout$/, /^\/mcp/, /^\/sw\.js$/];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key !== VERSION) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function cacheable(response) {
  return (
    response &&
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected &&
    !/no-store/i.test(response.headers.get('Cache-Control') || '')
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === 'navigate') {
    // Network first; fall back to the last good shell when offline.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (cacheable(response) && url.pathname === '/') {
            const cache = await caches.open(VERSION);
            await cache.put('/', response.clone());
          }
          return response;
        } catch (error) {
          const cached = await caches.match('/');
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  // Content-hashed build assets are immutable: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (cacheable(response)) {
          const cache = await caches.open(VERSION);
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
