/**
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Proxies GET /api/adsblol/mil to https://api.adsb.lol/v2/mil. On upstream
 * failure, serves a stale cached response if one exists.
 *
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy() {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsblol/mil', async (req, res) => {
      try {
        const now = Date.now();
        if (_cache && now - _cacheAt < CACHE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-ADS-B-Cache': 'HIT',
          });
          res.end(_cache);
          return;
        }
        const upstream = await fetch('https://api.adsb.lol/v2/mil', {
          headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
        });
        const body = await upstream.text();
        if (upstream.ok) {
          _cache = body;
          _cacheAt = now;
        }
        res.writeHead(upstream.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-ADS-B-Cache': 'MISS',
        });
        res.end(body);
      } catch (e) {
        console.error('[adsb.lol Proxy]', e.message);
        if (_cache) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-ADS-B-Cache': 'STALE',
          });
          res.end(_cache);
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
      }
    });
  };
  return {
    name: 'adsblol-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
