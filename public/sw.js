/**
 * God's Eye View service worker — app-shell caching for the installed PWA.
 *
 * Strategy:
 * - Documents (navigations, /index.html): network-first so updates flow,
 *   cache fallback when offline.
 * - Same-origin static assets (JS/CSS/icons/models): cache-first, cached on
 *   first fetch. Bundle names are content-hashed, so stale assets are
 *   impossible.
 * - /api/* and cross-origin (map tiles, CDNs): never intercepted — live
 *   data must never be served stale, and tile caches would blow storage.
 *
 * Bump CACHE when this file changes.
 */
const CACHE = 'gev-app-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const isDocument =
        request.mode === 'navigate' ||
        url.pathname === '/' ||
        url.pathname.endsWith('.html');
      if (isDocument) {
        try {
          const fresh = await fetch(request);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (await cache.match(request)) || (await cache.match('/index.html'));
        }
      }
      const cached = await cache.match(request);
      if (cached) return cached;
      const fresh = await fetch(request);
      if (fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })(),
  );
});
