import { clientNetworkKey, makeRateLimiter } from './rate-limit.js';
import { admitSameSiteKeyless } from './same-site.js';

/**
 * Last-known item counts per layer, for Context's nothing-on view:
 * how much each layer would show if it were turned on. Every count comes
 * from what a provider already holds in its own cache (memory or disk). The
 * registry never asks an upstream: a provider whose cache is empty has no
 * count, and its layer gets no tile.
 *
 * The local provider composition supplies the readers for feeds that do
 * not bill per request. Metered feeds (TomTom, Google) stay out even when cached.
 * Reading a count never spends quota, since nothing is fetched.
 */

/**
 * @typedef {{count: number, at: number|null}} CachedLayerCount
 * @typedef {() => (CachedLayerCount|null|Promise<CachedLayerCount|null>)} LayerCountReader
 */

/**
 * Every registered layer that has a count: `[{layerId, count, at}]`.
 * A reader that throws or has nothing is left out.
 * @param {Array<[string, LayerCountReader]>} readers
 * @returns {Promise<Array<{layerId: string, count: number, at: ?number}>>}
 */
async function readLayerCounts(readers) {
  const rows = await Promise.all(
    readers.map(async ([layerId, read]) => {
      try {
        const found = await read();
        const count = Number(found?.count);
        const at = found?.at == null ? null : Number(found.at);
        if (!Number.isFinite(count) || count <= 0) return null;
        return {
          layerId,
          count: Math.round(count),
          at: Number.isFinite(at) ? at : null,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter(Boolean);
}

/**
 * `GET /api/layer-counts` → `{now, counts: [{layerId, count, at}]}`. Read
 * from the providers' caches only; same-site, no key, no upstream request.
 * @param {Record<string, LayerCountReader>} readers
 */
export function layerCountsEndpoint(readers) {
  const entries = Object.entries(readers);
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  const install = (server) => {
    server.middlewares.use('/api/layer-counts', async (req, res, next) => {
      if ((req.url || '/').split('?', 1)[0] !== '/') return next();
      if (admitSameSiteKeyless(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          Allow: 'GET, HEAD',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      if (!allow(clientNetworkKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': '60',
        });
        res.end(
          req.method === 'HEAD'
            ? ''
            : JSON.stringify({ error: 'rate_limited' }),
        );
        return;
      }
      const counts =
        req.method === 'HEAD' ? [] : await readLayerCounts(entries);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        req.method === 'HEAD'
          ? ''
          : JSON.stringify({ now: Date.now(), counts }),
      );
    });
  };
  return {
    name: 'layer-counts',
    configureServer: install,
    configurePreviewServer: install,
  };
}
