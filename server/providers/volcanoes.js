import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';

/**
 * USGS HANS (Hazard Alert Notification System) proxy: keyless upstream
 * listing currently-elevated USGS-monitored volcanoes, cached in memory for
 * 15 min and single-flighted so concurrent requests share one upstream call.
 *
 * @returns {import('vite').Plugin}
 */
export function volcanoProxy() {
  const TTL_MS = 15 * 60_000;
  const MAX_BYTES = 512 * 1024;
  const UPSTREAM_URL = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';

  let cache = null; // { at: epochMs, body: unknown }
  const inflight = new Map();

  async function fetchUpstream() {
    const res = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseJsonCapped(res, MAX_BYTES);
    return { at: Date.now(), body };
  }

  function install(middlewares) {
    middlewares.use('/api/volcano-alerts', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const entry = cache;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, entry.body);
          return;
        }
        const { promise } = coalesceProxyRequest(inflight, 'volcanoes', async () => {
          try {
            const fresh = await fetchUpstream();
            cache = fresh;
            return fresh;
          } catch (err) {
            console.warn('[volcano-proxy] refresh failed — serving cache if any:', err?.message || err);
            return null;
          }
        });
        const fresh = await promise;
        if (fresh) {
          sendJson(200, fresh.body);
        } else if (entry) {
          sendJson(200, entry.body);
        } else {
          sendJson(502, { error: 'volcano fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[volcano-proxy] error:', err?.message || err);
        sendJson(500, { error: 'volcano proxy error' });
      }
    });
  }

  return {
    name: 'volcano-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
