import { readResponseTextCapped } from './common/http.js';
import { normalizeVolcanoes, normalizeAurora } from '../../src/layers/publicFeeds/source.js';

const FEEDS = {
  volcanoes: { url: 'https://volcanoes.usgs.gov/vsc/api/volcanoApi/geojson', normalize: normalizeVolcanoes, ttl: 300000 },
  aurora: { url: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json', normalize: normalizeAurora, ttl: 600000 },
};

/** Same-origin, fixed-destination proxy; only validated complete responses enter cache. */
export function publicFeedsProxy({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  async function acquire(kind) {
    const feed = FEEDS[kind], cached = cache.get(kind);
    if (cached && now() - cached.at < feed.ttl) return cached.body;
    if (!pending.has(kind)) {
      const operation = (async () => {
        const signal = AbortSignal.timeout(15000);
        const response = await fetchImpl(feed.url, { signal, redirect: 'error', headers: { Accept: 'application/json, application/geo+json', 'User-Agent': 'Gods Eye View public data' } });
        if (!response.ok) { await response.body?.cancel(); throw new Error('upstream unavailable'); }
        const body = await readResponseTextCapped(response, 8 * 1024 * 1024, signal);
        feed.normalize(JSON.parse(body));
        cache.set(kind, { body, at: now() });
        return body;
      })().finally(() => pending.delete(kind));
      pending.set(kind, operation);
    }
    return pending.get(kind);
  }
  async function handler(req, res) {
    const match = /^\/(volcanoes|aurora)$/.exec(req.url || '');
    if (req.method !== 'GET' || !match) {
      res.writeHead(req.method !== 'GET' ? 405 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":"invalid request"}'); return;
    }
    try {
      const body = await acquire(match[1]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body);
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"public feed unavailable"}');
    }
  }
  const install = ({ middlewares }) => { middlewares.use('/api/public-feeds', handler); };
  return { name: 'public-feeds', configureServer: install, configurePreviewServer: install };
}
