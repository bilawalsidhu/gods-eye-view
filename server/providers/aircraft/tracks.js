import { getOpenSkyToken } from './opensky.js';
import { readCappedResponseText } from '../common/http.js';
/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/opensky-track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   own credit bucket, 4 credits per call on the free tier). OAuth via the
 *   shared coalesced token. 60s per-icao cache; 404/429 forwarded so the
 *   client can fall back to its accumulated trail silently.
 * /api/adsblol/trace?hex=<hex> — adsb.lol tar1090 readsb trace
 *   (undocumented but live; no browser CORS, hence this proxy). Up to ~24h
 *   of real history per aircraft. Treat as best-effort; data is ODbL —
 *   credit "adsb.lol (ODbL)" in the UI.
 */
export function trackBackfillProxies() {
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  async function proxyJson(res, key, upstreamUrl, headers = {}) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    const upstream = await fetch(upstreamUrl, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    const { tooLarge, text } = await readCappedResponseText(
      upstream,
      RESPONSE_CAP_BYTES,
    );
    let body;
    if (tooLarge) {
      body = JSON.stringify({ error: 'Upstream track response too large' });
    } else if (!upstream.ok) {
      // Sanitize upstream error surface; status code is signal enough
      body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } else {
      body = text;
    }
    cachePut(key, { at: Date.now(), status: upstream.status, body });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  function install(middlewares) {
    middlewares.use('/api/opensky-track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const icao24 = String(incoming.searchParams.get('icao24') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(icao24)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'icao24 must be a 6-char hex string' }),
          );
          return;
        }
        const token = await getOpenSkyToken();
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          token ? { Authorization: `Bearer ${token}` } : {},
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OpenSky track fetch failed' }));
      }
    });

    middlewares.use('/api/adsblol/trace', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'hex must be a 6-7 char hex string' }),
          );
          return;
        }
        await proxyJson(
          res,
          `lol:${hex}`,
          `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
