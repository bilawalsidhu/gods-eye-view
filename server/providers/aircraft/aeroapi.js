import { readCappedResponseText } from '../common/http.js';

/**
 * Vite plugin: FlightAware AeroAPI proxy (issue #446).
 *
 * /api/aeroapi/<path> — same-origin broker for the AeroAPI REST surface the
 * client needs (GET /flights/{ident}, GET /flights/{id}/track). The
 * FLIGHTAWARE_AEROAPI_KEY never reaches the browser: it is attached
 * server-side as the documented `x-apikey` header against the fixed upstream
 * https://aeroapi.flightaware.com/aeroapi (registered host, no
 * user-controlled destination — no SSRF surface).
 *
 * Responses are cached per path for 5 minutes (track and flight-list responses
 * are immutable history; AeroAPI counts requests, so repeated tracking sessions
 * must not re-hit the API). Without a key every request is a sanitized 503 so
 * the client falls back to the keyless sources silently.
 */
export function aeroApiProxy() {
  const AEROAPI_BASE = 'https://aeroapi.flightaware.com/aeroapi';
  const CACHE_MS = 300000;
  const CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  const UPSTREAM_TIMEOUT_MS = 12000;

  /** @type {Map<string, {at:number,status:number,body:string}>} */
  const cache = new Map();

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  function sendJson(res, status, body, cacheStatus) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (cacheStatus) res.setHeader('X-AeroAPI-Cache', cacheStatus);
    res.end(body);
  }

  /** Idents are alphanumeric with the FA flight-id separators; everything
   *  else (traversal, encoded slashes, globs) is refused. */
  const IDENT_PATTERN = /^[A-Za-z0-9~^-]{1,16}$/;
  /** Query parameters the client may forward to AeroAPI; all else dropped. */
  const ALLOWED_QUERY = new Set([
    'start',
    'end',
    'ident_type',
    'max_pages',
    'cursor',
    'include_estimated_positions',
    'include_surface_positions',
  ]);

  function install(middlewares) {
    middlewares.use('/api/aeroapi', async (req, res) => {
      try {
        const apiKey = String(process.env.FLIGHTAWARE_AEROAPI_KEY ?? '').trim();
        if (!apiKey) {
          sendJson(res, 503, JSON.stringify({ error: 'AeroAPI key not set' }));
          return;
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        // connect strips the mount prefix, so req.url is '/flights/{ident}'
        // or '/flights/{id}/track' plus an optional query string.
        const incoming = new URL(req.url || '/', 'http://localhost');
        const segments = incoming.pathname.split('/').filter(Boolean);
        const isFlightList =
          segments.length === 2 &&
          segments[0] === 'flights' &&
          IDENT_PATTERN.test(segments[1]);
        const isTrack =
          segments.length === 3 &&
          segments[0] === 'flights' &&
          IDENT_PATTERN.test(segments[1]) &&
          segments[2] === 'track';
        if (!isFlightList && !isTrack) {
          sendJson(
            res,
            400,
            JSON.stringify({ error: 'Unsupported AeroAPI path' }),
          );
          return;
        }
        // Rebuild the query from whitelisted keys only; unknown parameters
        // never reach upstream.
        const query = new URLSearchParams();
        for (const [key, value] of incoming.searchParams) {
          if (ALLOWED_QUERY.has(key)) query.set(key, value);
        }
        const suffix = `${incoming.pathname}${query.size ? '?' + query : ''}`;
        const cacheKey = `aeroapi:${suffix}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.at < CACHE_MS) {
          sendJson(res, cached.status, cached.body, 'HIT');
          return;
        }
        const url = `${AEROAPI_BASE}${suffix}`;
        const upstream = await fetch(url, {
          headers: { 'x-apikey': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const { tooLarge, text } = await readCappedResponseText(
          upstream,
          RESPONSE_CAP_BYTES,
        );
        const body = tooLarge
          ? JSON.stringify({ error: 'Upstream response too large' })
          : upstream.ok
            ? text
            : JSON.stringify({ error: `AeroAPI HTTP ${upstream.status}` });
        cachePut(cacheKey, { at: Date.now(), status: upstream.status, body });
        sendJson(res, upstream.status, body, 'MISS');
      } catch (error) {
        console.error('[AeroAPI Proxy]', error?.message || error);
        sendJson(res, 502, JSON.stringify({ error: 'AeroAPI fetch failed' }));
      }
    });
  }

  return {
    name: 'aeroapi-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
