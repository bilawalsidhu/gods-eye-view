import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';

/**
 * NOAA SWPC aurora-forecast proxy: keyless upstream (OVATION model JSON),
 * cached in memory for 10 min — NOAA's own refresh cadence — and
 * single-flighted so concurrent requests share one upstream call.
 *
 * @returns {import('vite').Plugin}
 */
export function auroraProxy() {
  const TTL_MS = 10 * 60_000;
  const MAX_BYTES = 4 * 1024 * 1024; // the global ~1° grid runs a few MB
  const UPSTREAM_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

  let cache = null; // { at: epochMs, body: object }
  const inflight = new Map();

  async function fetchUpstream() {
    const res = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseJsonCapped(res, MAX_BYTES);
    if (!body || typeof body !== 'object') throw new Error('malformed NOAA SWPC response');
    return { at: Date.now(), body };
  }

  function install(middlewares) {
    middlewares.use('/api/aurora', async (req, res) => {
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
        const { promise } = coalesceProxyRequest(inflight, 'aurora', async () => {
          try {
            const fresh = await fetchUpstream();
            cache = fresh;
            return fresh;
          } catch (err) {
            console.warn('[aurora-proxy] refresh failed — serving cache if any:', err?.message || err);
            return null;
          }
        });
        const fresh = await promise;
        if (fresh) {
          sendJson(200, fresh.body);
        } else if (entry) {
          sendJson(200, entry.body);
        } else {
          sendJson(502, { error: 'aurora fetch failed and no cache available' });
        }
      } catch (err) {
        console.warn('[aurora-proxy] error:', err?.message || err);
        sendJson(500, { error: 'aurora proxy error' });
      }
    });
  }

  return {
    name: 'aurora-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
