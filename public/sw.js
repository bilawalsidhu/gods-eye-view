/**
 * JARVIS Service Worker — Enables offline caching and PWA install.
 * Caches the app shell for instant load on mobile.
 */

const CACHE_NAME = 'jarvis-gev-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Partial caching is OK — some assets may not exist yet
      });
    }),
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', (event) => {
  // Skip API requests and non-GET
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful full responses (avoid 206 Partial Content which throws in Cache API)
        if (
          response.ok &&
          response.status === 200 &&
          event.request.url.startsWith('http')
        ) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => {
        // Offline fallback
        return caches
          .match(event.request)
          .then((cached) => cached || new Response('Offline', { status: 503 }));
      }),
  );
});
