import { getOpenSkyToken } from './opensky.js';
import {
  coalesceProxyRequest,
  readCappedResponseText,
} from '../common/http.js';
import { clientKey, makeRateLimiter } from '../common/rate-limit.js';

function basicOpenSkyHeaders() {
  const username = process.env.OPENSKY_USERNAME;
  const password = process.env.OPENSKY_PASSWORD;
  return username && password
    ? {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      }
    : {};
}

async function openSkyTrackHeaders(mode) {
  if (mode === 'anon') return {};
  if (mode === 'basic') return basicOpenSkyHeaders();
  const token = await getOpenSkyToken();
  if (token) return { Authorization: `Bearer ${token}` };
  return mode === 'auto' ? basicOpenSkyHeaders() : {};
}
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
  const TRACK_CACHE_MS = 60_000;
  const TRACK_CACHE_MAX = 200;
  const TRACK_CACHE_BYTES = 24 * 1024 * 1024;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  const OVERFLOW_COOLDOWN_MS = 5_000;
  const IN_FLIGHT_MAX = 4;
  const OPEN_SKY_IN_FLIGHT_MAX = 3; // Preserve one slot for adsb.lol.
  const OPEN_SKY_DAILY_MAX = 250; // Four OpenSky credits per uncached track.
  const OPEN_SKY_DAY_MS = 86_400_000;
  const allowMinute = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 60,
  });
  const openSkyDailyTimes = [];
  /** @type {Map<string, {at:number,status:number,body:string,bytes:number}>} */
  const cache = new Map();
  const inFlight = new Map();
  const overflowUntil = new Map();
  let cachedBytes = 0;

  function cachePut(key, entry) {
    const bytes = Buffer.byteLength(entry.body);
    const previous = cache.get(key);
    if (previous) cachedBytes -= previous.bytes;
    cache.delete(key);
    cache.set(key, { ...entry, bytes });
    cachedBytes += bytes;
    while (cache.size > TRACK_CACHE_MAX || cachedBytes > TRACK_CACHE_BYTES) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
  }

  function respond(res, status, body, retryAfter) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.end(body);
  }

  async function proxyJson(req, res, key, upstreamUrl, headersForRequest) {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.at < TRACK_CACHE_MS) {
      respond(res, cached.status, cached.body);
      return;
    }
    const existing = inFlight.get(key);
    if (existing) {
      const result = await existing;
      respond(res, result.status, result.body);
      return;
    }
    const until = overflowUntil.get(key);
    if (until > now) {
      respond(
        res,
        429,
        JSON.stringify({ error: 'Track source cooling down' }),
        Math.ceil((until - now) / 1000),
      );
      return;
    }
    if (until) overflowUntil.delete(key);
    const isOpenSky = key.startsWith('osky:');
    if (isOpenSky) {
      while (
        openSkyDailyTimes.length &&
        now - openSkyDailyTimes[0] >= OPEN_SKY_DAY_MS
      )
        openSkyDailyTimes.shift();
      if (openSkyDailyTimes.length >= OPEN_SKY_DAILY_MAX) {
        respond(
          res,
          429,
          JSON.stringify({ error: 'OpenSky track daily limit reached' }),
          Math.ceil((openSkyDailyTimes[0] + OPEN_SKY_DAY_MS - now) / 1000),
        );
        return;
      }
      let activeOpenSky = 0;
      for (const activeKey of inFlight.keys())
        if (activeKey.startsWith('osky:')) activeOpenSky++;
      if (activeOpenSky >= OPEN_SKY_IN_FLIGHT_MAX) {
        respond(
          res,
          429,
          JSON.stringify({ error: 'Track request limit reached' }),
          12,
        );
        return;
      }
    }
    if (inFlight.size >= IN_FLIGHT_MAX) {
      respond(
        res,
        429,
        JSON.stringify({ error: 'Track request limit reached' }),
        12,
      );
      return;
    }
    if (!allowMinute(clientKey(req))) {
      respond(
        res,
        429,
        JSON.stringify({ error: 'Track request limit reached' }),
        60,
      );
      return;
    }
    if (isOpenSky) openSkyDailyTimes.push(now);
    const { promise } = coalesceProxyRequest(inFlight, key, async () => {
      const requestedMode = isOpenSky
        ? String(process.env.OPENSKY_AUTH_MODE || 'oauth')
            .trim()
            .toLowerCase()
        : null;
      const headers = headersForRequest
        ? await headersForRequest(requestedMode)
        : {};
      const signal = AbortSignal.timeout(12_000);
      let upstream = await fetch(upstreamUrl, { headers, signal });
      if (
        requestedMode === 'auto' &&
        headers.Authorization?.startsWith('Bearer ') &&
        (upstream.status === 401 || upstream.status === 403)
      ) {
        const basic = basicOpenSkyHeaders();
        if (basic.Authorization) {
          upstream.body?.cancel().catch(() => {});
          upstream = await fetch(upstreamUrl, { headers: basic, signal });
        }
      }
      const { tooLarge, text } = await readCappedResponseText(
        upstream,
        RESPONSE_CAP_BYTES,
      );
      if (tooLarge) {
        overflowUntil.set(key, Date.now() + OVERFLOW_COOLDOWN_MS);
        if (overflowUntil.size > TRACK_CACHE_MAX)
          overflowUntil.delete(overflowUntil.keys().next().value);
        return {
          status: 502,
          body: JSON.stringify({ error: 'Upstream track response too large' }),
        };
      }
      const body = upstream.ok
        ? text
        : JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
      const result = { status: upstream.status, body };
      cachePut(key, { at: Date.now(), ...result });
      return result;
    });
    const result = await promise;
    respond(res, result.status, result.body);
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
        await proxyJson(
          req,
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          openSkyTrackHeaders,
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
          req,
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
