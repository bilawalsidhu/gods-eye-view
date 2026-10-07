// Only the independent planetary page and bundled public maps. No Earth/private APIs.
const CACHE = 'gods-eye-view.planets-shell.v1';
const SHELL = '/planet.html';
async function refreshShell() {
  const pending = new Map();
  const queue = [
    SHELL,
    '/planetary/moon.jpg',
    '/planetary/mars.jpg',
    '/planetary/manifest.json',
  ].map((path) => new URL(path, self.location.origin).href);
  let bytes = 0;
  while (queue.length) {
    const url = queue.shift();
    if (pending.has(url)) continue;
    if (pending.size >= 32) throw new Error('Asset limit exceeded.');
    const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new Error('Planet resource unavailable.');
    bytes += (await response.clone().blob()).size;
    if (bytes > 5 * 1024 * 1024) throw new Error('Planet pack limit is 5 MiB.');
    pending.set(url, response);
    const type = response.headers.get('content-type') ?? '';
    if (/html|javascript/.test(type)) {
      const text = await response.clone().text();
      const refs = type.includes('html')
        ? [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
            (match) => match[1],
          )
        : [...text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map(
            (match) => match[1],
          );
      for (const ref of refs) {
        const asset = new URL(ref, url);
        if (
          asset.origin === self.location.origin &&
          asset.pathname.startsWith('/assets/') &&
          !pending.has(asset.href)
        )
          queue.push(asset.href);
      }
    }
  }
  const cache = await caches.open(CACHE);
  for (const [url, response] of pending) await cache.put(url, response);
  for (const request of await cache.keys())
    if (!pending.has(request.url)) await cache.delete(request);
}
self.addEventListener('install', (event) =>
  event.waitUntil(refreshShell().then(() => self.skipWaiting())),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'REFRESH_PLANET_SHELL')
    event.waitUntil(
      refreshShell().then(
        () => event.ports[0]?.postMessage({ ok: true }),
        () => event.ports[0]?.postMessage({ ok: false }),
      ),
    );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !(
      url.pathname === SHELL ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/planetary/')
    )
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .then(
        async (cache) =>
          (await cache.match(
            url.pathname === SHELL
              ? new URL(SHELL, self.location.origin).href
              : event.request,
          )) ?? fetch(event.request),
      ),
  );
});
