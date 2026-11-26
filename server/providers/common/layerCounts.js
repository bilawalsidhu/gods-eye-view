import { clientNetworkKey, makeRateLimiter } from './rate-limit.js';
import { admitSameSiteKeyless } from './same-site.js';

/**
 * Last-known counts from providers' own caches. The endpoint only reads
 * existing data for eligible feeds, so requests use no upstream quota.
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
        if (!Number.isFinite(found?.count) || found.count <= 0) return null;
        return { layerId, count: found.count, at: found.at ?? null };
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
      const head = req.method === 'HEAD';
      const limited = !allow(clientNetworkKey(req));
      const counts = head || limited ? [] : await readLayerCounts(entries);
      res.writeHead(limited ? 429 : 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(limited && { 'Retry-After': '60' }),
      });
      res.end(
        JSON.stringify(
          limited ? { error: 'rate_limited' } : { now: Date.now(), counts },
        ),
      );
    });
  };
  return {
    name: 'layer-counts',
    configureServer: install,
    configurePreviewServer: install,
  };
}
