import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';

/**
 * Open-Meteo UV Index proxy: same shape as airQualityProxy (keyless upstream,
 * proxied to cache the fixed multi-city batch server-side), pointed at the
 * regular forecast API's `current=uv_index` instead of the air-quality API.
 *
 * @returns {import('vite').Plugin}
 */
export function uvIndexProxy() {
  const TTL_MS = 15 * 60_000;
  const MAX_BYTES = 512 * 1024;
  const UPSTREAM_BASE = 'https://api.open-meteo.com/v1/forecast';

  const mem = new Map();
  const inflight = new Map();

  async function fetchUpstream(queryString) {
    const res = await fetch(`${UPSTREAM_BASE}?${queryString}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseJsonCapped(res, MAX_BYTES);
    return { at: Date.now(), body };
  }

  function install(middlewares) {
    middlewares.use('/api/uv-index', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      const queryString = String(req.url || '').split('?')[1] || '';
      if (!queryString) {
        sendJson(400, { error: 'missing query' });
        return;
      }
      try {
        const entry = mem.get(queryString);
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, entry.body);
          return;
        }
        const { promise } = coalesceProxyRequest(inflight, queryString, async () => {
          try {
            const fresh = await fetchUpstream(queryString);
            mem.set(queryString, fresh);
            return fresh;
          } catch (err) {
            console.warn('[uv-index-proxy] refresh failed — serving cache if any:', err?.message || err);
            return null;
          }
        });
        const fresh = await promise;
        if (fresh) {
          sendJson(200, fresh.body);
        } else if (entry) {
          sendJson(200, entry.body);
        } else {
          sendJson(502, { error: 'uv index fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[uv-index-proxy] error:', err?.message || err);
        sendJson(500, { error: 'uv index proxy error' });
      }
    });
  }

  return {
    name: 'uv-index-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
