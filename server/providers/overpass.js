import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readRequestBodyCapped } from './common/request.js';
import {
  OVERPASS_MAX_BODY_BYTES,
  OVERPASS_MAX_CONCURRENT,
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
  OVERPASS_PROVIDER_SOURCE,
  overpassPayloadIsData,
  fetchOverpassPayload,
} from './overpass/transport.js';
import { overpassMirrorLabel } from './overpass/constants.js';
import { providerStatus, statusHeaders } from './common/upstream.js';
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
 * `X-Provider-*` headers for an Overpass proxy answer (the MOVEMENT status
 * contract, server/providers/common/upstream.js): `live` for data straight
 * from a mirror or from a fresh cache entry, `stale` when last-good data is
 * served past its TTL, `degraded` for the structured all-mirrors-failed
 * answer. `fetchedAt` is when the DATA was obtained (cache entries carry
 * `cachedAt`), so the age is honest for cached answers. The proxy keeps its
 * own `Cache-Control`, so the helper's is dropped here.
 * @param {{status:number,endpoint?:string,cachedAt?:number,provider?:object}} payload
 * @param {string} cacheStatus 'HIT' | 'MISS' | 'INFLIGHT' | 'DISK' | 'STALE'
 */
function providerHeadersFor(payload, cacheStatus) {
  const isData = overpassPayloadIsData(payload);
  const mirror =
    payload.endpoint && payload.endpoint !== 'unknown'
      ? ` (${overpassMirrorLabel(payload.endpoint)})`
      : '';
  const status = providerStatus({
    status: isData ? (cacheStatus === 'STALE' ? 'stale' : 'live') : 'degraded',
    source: `${OVERPASS_PROVIDER_SOURCE}${mirror}`,
    fetchedAt: payload.cachedAt ?? Date.now(),
    error: isData ? null : (payload.provider?.error ?? null),
  });
  const headers = statusHeaders(status);
  delete headers['Cache-Control'];
  return headers;
}

/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', 'INFLIGHT', 'DISK' or 'STALE'.
 */
function sendOverpassResponse(res, payload, cacheStatus = 'MISS') {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': 'public, max-age=15',
    'X-Overpass-Cache': cacheStatus,
    'X-Overpass-Upstream': payload.endpoint || 'unknown',
    ...providerHeadersFor(payload, cacheStatus),
  });
  res.end(payload.body || '');
}

/**
 * The structured "every mirror failed" answer: HTTP 503 (never a raw 502 or
 * a mirror's 406 page), a JSON body `{ error, provider, failures }` and the
 * `X-Provider-*` headers, so the DATA LAYERS row reads
 * `DEGRADED · Overpass · <reason>` (src/layers/traffic/ingestion.js).
 * @param {import('http').ServerResponse} res
 * @param {object|null} provider  providerStatus() from the transport (or null)
 * @param {Array<object>} [failures]
 * @param {string} [endpoint]  last mirror tried
 */
function sendOverpassDegraded(
  res,
  provider,
  failures = [],
  endpoint = 'unknown',
) {
  const status = providerStatus({
    status: 'degraded',
    source: OVERPASS_PROVIDER_SOURCE,
    error:
      (typeof provider?.error === 'string' && provider.error.trim()) ||
      'Overpass mirrors unavailable',
    count: 0,
  });
  res.writeHead(503, {
    'Content-Type': 'application/json',
    'Retry-After': '30',
    'X-Overpass-Cache': 'MISS',
    'X-Overpass-Upstream': endpoint || 'unknown',
    ...statusHeaders(status),
  });
  res.end(
    JSON.stringify({
      error: status.error,
      provider: status,
      failures: Array.isArray(failures) ? failures : [],
    }),
  );
}

/**
 * Vite plugin: Overpass API proxy with response caching and request coalescing.
 *
 * Accepts POST requests at /api/overpass, normalizes the query body for
 * cache keying, and fans out to multiple Overpass mirrors with per-upstream
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
        const preflight = await resolveOverpassPreflight({
          cacheKey,
          memoryCache: _overpassCache,
          inFlight: _overpassInFlight,
          // Fresh-enough disk entries survive restarts and skip the public
          // mirrors; boundary-class queries keep their month-long TTL.
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
            if (preflight.payload?.provider) {
              sendOverpassDegraded(
                res,
                preflight.payload.provider,
                preflight.payload.failures,
                preflight.payload.endpoint,
              );
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
          // Every mirror failed for infrastructure reasons (406/429/5xx,
          // timeouts, network): the structured DEGRADED answer. A query every
          // mirror rejected (400-class) carries no `provider` and is passed
          // through as upstream's own verdict.
          if (payload.provider) {
            sendOverpassDegraded(
              res,
              payload.provider,
              payload.failures,
              payload.endpoint,
            );
            return;
          }
        }
        sendOverpassResponse(res, payload, 'MISS');
      } catch (e) {
        // Every mirror threw (network-level) or the proxy itself failed. Same
        // serve-stale rule; otherwise the structured DEGRADED answer (HTTP
        // 503 + reason) — never a bare 502 the row would print verbatim.
        const stale = cacheKey ? await readStaleOverpass(cacheKey) : null;
        if (stale) {
          sendOverpassResponse(res, stale, 'STALE');
          return;
        }
        console.error('[Overpass Proxy]', e.message);
        sendOverpassDegraded(
          res,
          e?.provider ||
            providerStatus({
              status: 'degraded',
              source: OVERPASS_PROVIDER_SOURCE,
              error: `Overpass proxy error · ${String(e?.message || 'unknown').slice(0, 120)}`,
              count: 0,
            }),
          e?.failures,
          e?.failures?.[e.failures.length - 1]?.endpoint,
        );
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
