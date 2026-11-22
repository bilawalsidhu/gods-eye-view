import { admitSameSiteKeyless } from './same-site.js';

/**
 * Last-known item counts per layer, for Context's nothing-on view:
 * how much each layer would show if it were turned on. Every count comes
 * from what a provider already holds in its own cache (memory or disk). The
 * registry never asks an upstream: a provider whose cache is empty has no
 * count, and its layer gets no tile.
 *
 * Only layers whose feed is not billed per request register (see each
 * provider). Metered feeds (TomTom, Google) stay out even when cached.
 * Reading a count never spends quota, since nothing is fetched.
 */

/** @type {Map<string, () => (?{count: number, at: ?number}|Promise<?{count: number, at: ?number}>)>} */
const readers = new Map();

/**
 * Register how a layer's last-known count is read from its provider's cache.
 * The reader returns null when the cache is empty; it must not fetch.
 * @param {string} layerId The app's layer id.
 * @param {() => (?{count: number, at: ?number}|Promise<?{count: number, at: ?number}>)} read
 */
export function registerLayerCount(layerId, read) {
  if (!layerId || typeof read !== 'function') return;
  readers.set(layerId, read);
}

/**
 * Every registered layer that has a count: `[{layerId, count, at}]`.
 * A reader that throws or has nothing is left out.
 * @returns {Promise<Array<{layerId: string, count: number, at: ?number}>>}
 */
export async function readLayerCounts() {
  const rows = await Promise.all(
    [...readers].map(async ([layerId, read]) => {
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

/** Forget every reader (tests). */
export function _resetLayerCountsForTest() {
  readers.clear();
}

/**
 * `GET /api/layer-counts` → `{now, counts: [{layerId, count, at}]}`. Read
 * from the providers' caches only; same-site, no key, no upstream request.
 */
export function layerCountsEndpoint() {
  const install = (server) => {
    server.middlewares.use('/api/layer-counts', async (req, res) => {
      if (admitSameSiteKeyless(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          Allow: 'GET, HEAD',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const counts = await readLayerCounts();
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
