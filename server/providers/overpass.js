import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readRequestBodyCapped } from './common/request.js';
import {
  OVERPASS_MAX_BODY_BYTES,
  OVERPASS_MAX_CONCURRENT,
  resolveOverpassUpstreams,
} from './overpass/constants.js';
import { sanitizeOverpassBody } from './overpass/query.js';
import {
  resolveOverpassPreflight,
  _overpassCache,
  readOverpassDisk,
  overpassDiskTtlMs,
  readStaleOverpass,
  trimOverpassCache,
  writeOverpassDisk,
} from './overpass/cache.js';
import {
  overpassPayloadIsData,
  fetchOverpassPayload,
  overpassNotConfigured,
} from './overpass/transport.js';
import { installRouteMiddleware } from './places/routes.js';

/** @type {Map<string,Promise>} In-flight Overpass requests keyed by normalized query body. */
const _overpassInFlight = new Map();

let _overpassConcurrent = 0;

const _overpassRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 90,
  globalMax: 300,
});

/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', or 'INFLIGHT'.
 */
function sendOverpassResponse(res, payload, cacheStatus = 'MISS') {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': overpassPayloadIsData(payload)
      ? 'public, max-age=15'
      : 'no-store',
    'X-Overpass-Cache': cacheStatus,
    ...(Number.isFinite(payload.cachedAt)
      ? { 'X-Overpass-Cached-At': new Date(payload.cachedAt).toISOString() }
      : {}),
    ...(payload.retryAfterMs
      ? { 'Retry-After': String(Math.ceil(payload.retryAfterMs / 1000)) }
      : {}),
  });
  res.end(payload.body || '');
}

/**
 * Vite plugin: Overpass API proxy with response caching and request coalescing.
 *
 * Accepts POST requests at /api/overpass, normalizes the query body for
 * cache keying, and uses only operator-configured endpoints with per-upstream
 * timeout and rate-limit detection. Successful responses are cached for
 * OVERPASS_CACHE_MS. Concurrent identical queries share a single upstream
 * request via the in-flight map.
 *
 * @returns {import('vite').Plugin}
 */
function overpassProxy({ routing = {} } = {}) {
  const installMiddleware = (server) => {
    server.middlewares.use('/api/overpass', async (req, res) => {
      // Hoisted out of the try so the catch's serve-stale lookup can see it
      // (a body-read failure would otherwise hit an out-of-scope reference).
      let cacheKey = null;
      try {
        // Capability probe: lets clients skip queries when nothing is configured.
        if (req.method === 'GET' && req.url?.split('?')[0] === '/status') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              configured: resolveOverpassUpstreams().length > 0,
            }),
          );
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        // Collect POST body with a hard byte cap (Overpass QL queries are small)
        let body;
        try {
          body = (
            await readRequestBodyCapped(req, OVERPASS_MAX_BODY_BYTES)
          ).toString();
        } catch (err) {
          if (err?.code === 'BODY_TOO_LARGE') {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Overpass query too large' }));
            return;
          }
          throw err;
        }
        if (!body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing Overpass query body' }));
          return;
        }

        // Validate + clamp the QL: reject unbounded/global queries and cap the
        // server-side timeout so a tiny body can't request planet-scale work.
        const sanitized = sanitizeOverpassBody(body);
        if (!sanitized.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: sanitized.error }));
          return;
        }
        const safeBody = sanitized.body;

        // Normalize whitespace so semantically identical Overpass QL queries share cache entries
        cacheKey = safeBody.replace(/\s+/g, ' ').trim();
        if (!resolveOverpassUpstreams().length) {
          const cached = await readStaleOverpass(cacheKey);
          sendOverpassResponse(
            res,
            cached || overpassNotConfigured(),
            cached ? 'STALE' : 'DISABLED',
          );
          return;
        }
        const preflight = await resolveOverpassPreflight({
          cacheKey,
          memoryCache: _overpassCache,
          inFlight: _overpassInFlight,
          // Fresh-enough disk entries survive restarts and skip upstream
          // requests; boundary-class queries keep their month-long TTL.
          readDisk: () =>
            readOverpassDisk(cacheKey, overpassDiskTtlMs(cacheKey)),
          allowUpstream: () => _overpassRateLimiter(clientKey(req)),
        });
        if (preflight.source === 'RATE_LIMITED') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
        if (preflight.source !== 'UPSTREAM') {
          // A coalesced caller sees the same failure as the original request
          // and must get the same last-good fallback, not the raw refusal.
          if (!overpassPayloadIsData(preflight.payload)) {
            const stale = await readStaleOverpass(cacheKey);
            if (stale) {
              sendOverpassResponse(res, stale, 'STALE');
              return;
            }
          }
          if (preflight.source === 'DISK') {
            _overpassCache.set(cacheKey, preflight.payload);
            trimOverpassCache();
          }
          sendOverpassResponse(res, preflight.payload, preflight.source);
          return;
        }

        // From here onward the request is genuinely upstream-bound and has
        // consumed one local limiter slot. Cache and dedupe hits above do not.
        if (_overpassConcurrent >= OVERPASS_MAX_CONCURRENT) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          });
          res.end(
            JSON.stringify({
              error: 'Overpass proxy busy — try again shortly',
            }),
          );
          return;
        }
        _overpassConcurrent += 1;
        const requestPromise = fetchOverpassPayload(safeBody)
          .then((payload) => {
            // Only a 2xx is data. `< 500` cached every 4xx, so one mirror's
            // refusal was written to memory AND disk — and boundary-class
            // queries hold a month-long TTL, so a single 406 outlived the
            // outage that caused it.
            if (overpassPayloadIsData(payload)) {
              const entry = { ...payload, cachedAt: Date.now() };
              _overpassCache.set(cacheKey, entry);
              trimOverpassCache();
              writeOverpassDisk(cacheKey, entry);
            }
            return payload;
          })
          .finally(() => {
            _overpassConcurrent -= 1;
            _overpassInFlight.delete(cacheKey);
          });

        _overpassInFlight.set(cacheKey, requestPromise);
        const payload = await requestPromise;
        // Degraded upstream (rate-limited on every mirror / 5xx / runtime
        // error): last-good roads beat an empty layer — serve stale from
        // memory or disk at ANY age before surfacing the failure.
        if (!overpassPayloadIsData(payload)) {
          const stale = await readStaleOverpass(cacheKey);
          if (stale) {
            sendOverpassResponse(res, stale, 'STALE');
            return;
          }
        }
        sendOverpassResponse(res, payload, 'MISS');
      } catch (e) {
        // Every mirror threw (network-level). Same serve-stale rule.
        const stale = cacheKey ? await readStaleOverpass(cacheKey) : null;
        if (stale) {
          sendOverpassResponse(res, stale, 'STALE');
          return;
        }
        console.error('[Overpass Proxy] request failed');
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Overpass proxy error' }));
      }
    });

    installRouteMiddleware(server.middlewares, routing);
  };
  return {
    name: 'overpass-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export { overpassProxy };

export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
