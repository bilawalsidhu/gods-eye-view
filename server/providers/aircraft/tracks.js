import { getOpenSkyToken, openSkyRateLimitCooldownMs } from './opensky.js';
import { readCappedResponseText } from '../common/http.js';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/flights/track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   4 credits per call from the `/tracks/*` bucket, which OpenSky keeps
 *   separate from the `/states/*` one `/api/flights` spends). OAuth via the
 *   shared coalesced token. 60s per-icao cache; 404/429 forwarded so the
 *   client can fall back to its accumulated trail silently. Each route has
 *   its own per-IP limiter, and a 429 from /tracks starts a cooldown for that
 *   bucket — the per-icao cache bounds memory, not spend, since a different
 *   `icao24` is simply a different key.
 * /api/military/track?hex=<hex> — adsb.lol tar1090 readsb trace
 *   (undocumented but live; no browser CORS, hence this proxy). Up to ~24h
 *   of real history per aircraft. Treat as best-effort; data is ODbL —
 *   credit "adsb.lol (ODbL)" in the UI.
 */
export function trackBackfillProxies() {
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /**
   * Requests/min/IP. The per-icao cache below bounds MEMORY, not request
   * volume: every distinct `icao24` is a fresh key, and `icao24` is 6 hex
   * digits, so varying it walks straight past the cache into a live call.
   *
   * Sized against demand, not guessed: a backfill is issued once per aircraft
   * the operator SELECTS (`_backfillTrail`, fired from the tracked-contact
   * path in the flights, military and vessels layers), and re-selecting the
   * same aircraft inside a minute is served from cache. The assistant's
   * `get_aircraft_track` tool asks once per call, a handful per turn. 30/min
   * is a target switch every two seconds, sustained — well clear of either,
   * and the same band `/api/geocode` and `/api/regional-brief` already use.
   * Each route gets its own limiter: they spend different upstreams.
   */
  const TRACK_RATE_PER_MIN = 30;
  const TRACK_RATE_WINDOW_MS = 60_000;
  const trackLimiter = () =>
    makeRateLimiter({
      windowMs: TRACK_RATE_WINDOW_MS,
      max: TRACK_RATE_PER_MIN,
      globalMax: TRACK_RATE_PER_MIN * 3,
    });
  const allowOpenSky = trackLimiter();
  const allowAdsbLol = trackLimiter();
  /**
   * `/tracks/*` credit governor: a 429 from /tracks/all means that bucket is
   * empty for every `icao24`, so no upstream call is made until OpenSky's
   * retry-after passes. The `/states/*` cooldown in opensky.js is a different
   * bucket and does not apply here.
   */
  let openSkyTracksCooldownUntil = 0;
  const openSkyTracksGovernor = {
    remainingMs: () => Math.max(0, openSkyTracksCooldownUntil - Date.now()),
    arm(upstream) {
      openSkyTracksCooldownUntil =
        Date.now() + openSkyRateLimitCooldownMs(upstream);
    },
  };
  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();

  /** Shared refusal shape, matching the other rate-limited proxies. */
  function refuse(res, retryAfterSeconds) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    });
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  }

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  /**
   * @param {{remainingMs: () => number, arm: (upstream: Response) => void}} [governor]
   *   Credit cooldown for a metered upstream. While it is cooling the upstream
   *   is not called, though an already-fetched body may still be served (it
   *   costs nothing further); an upstream 429 arms it.
   */
  async function proxyJson(res, key, upstreamUrl, headers = {}, governor) {
    const blockedMs = governor?.remainingMs() ?? 0;
    const cached = cache.get(key);
    const fresh = cached && Date.now() - cached.at < TRACK_CACHE_MS;
    // Serve-stale while the account is cooling, the way `/api/flights` does:
    // a stale trail beats no trail, and replaying a cached body spends no
    // credits.
    if (cached && (fresh || blockedMs > 0)) {
      res.statusCode = cached.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(cached.body);
      return;
    }
    if (blockedMs > 0) {
      refuse(res, blockedMs / 1000);
      return;
    }
    const upstream = await fetch(upstreamUrl, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (upstream.status === 429) governor?.arm(upstream);
    const { tooLarge, text } = await readCappedResponseText(
      upstream,
      RESPONSE_CAP_BYTES,
    );
    let body;
    let status = upstream.status;
    if (tooLarge) {
      status = 502;
      body = JSON.stringify({ error: 'Upstream track response too large' });
    } else if (!upstream.ok) {
      // Sanitize upstream error surface; status code is signal enough
      body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } else {
      body = text;
    }
    // Cache the 502 like any upstream error: /tracks/all costs OpenSky
    // credits, so a retry inside the window must not re-download the body.
    cachePut(key, { at: Date.now(), status, body });
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  function install(middlewares) {
    middlewares.use('/api/flights/track', async (req, res) => {
      try {
        if (!allowOpenSky(clientKey(req))) {
          refuse(res, TRACK_RATE_WINDOW_MS / 1000);
          return;
        }
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
        // While the /tracks bucket is cooling, do not mint a token either.
        const token =
          openSkyTracksGovernor.remainingMs() > 0
            ? null
            : await getOpenSkyToken();
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          token ? { Authorization: `Bearer ${token}` } : {},
          openSkyTracksGovernor,
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OpenSky track fetch failed' }));
      }
    });

    middlewares.use('/api/military/track', async (req, res) => {
      try {
        // adsb.lol is free and unmetered, so no credit governor applies here —
        // the limiter is for the operator's own IP reputation with a community
        // service, the same reason `/api/overpass` carries one.
        if (!allowAdsbLol(clientKey(req))) {
          refuse(res, TRACK_RATE_WINDOW_MS / 1000);
          return;
        }
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
