import {
  makeRateLimiter,
  clientKey,
  clientNetworkKey,
  isLoopbackPeer,
} from './common/rate-limit.js';
import { hasProxySignals } from '../../src/localRequestGate.mjs';
import { readRequestBodyCapped } from './common/request.js';
import { admitSameSiteKeyless } from './common/same-site.js';
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

// Bound body-reading and validation work, including malformed requests and
// cache hits, before a byte is read. Remote peers share one global window so
// address rotation cannot mint admission without bound (IPv6 peers are keyed
// by /64 for the same reason). A direct loopback request — the owner's own
// browser and the repo QA harnesses, with no forwarding headers — has its own
// per-peer window outside that global, so busy LAN peers cannot lock the owner
// out of the map. A request relayed by a reverse proxy on this machine also
// arrives from loopback, but it is remote traffic: it is admitted from the
// remote pool under its own socket-keyed bucket, never from the owner's. The
// forwarded client address is not trusted as identity. Only admission is
// isolated: the upstream budget below (90/min per key, 300/min globally) is
// shared, so an owner request that misses cache can still be refused there.
const OVERPASS_ADMISSION_WINDOW = { windowMs: 60_000, max: 300 };
const _overpassLoopbackAdmission = makeRateLimiter(OVERPASS_ADMISSION_WINDOW);
const _overpassPeerAdmission = makeRateLimiter({
  ...OVERPASS_ADMISSION_WINDOW,
  globalMax: 900,
});

const _overpassRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 90,
  globalMax: 300,
});

/**
 * Classify a request for admission. Direct loopback — a loopback socket with
 * no forwarding header — is the owner's own pool; everything else, including a
 * loopback socket that carries forwarding headers (a local reverse proxy), is
 * remote. A proxied request keeps its socket identity under a `proxied:`
 * prefix, so it never shares a bucket with the owner's direct requests.
 * @param {import('http').IncomingMessage} req
 * @returns {{direct: boolean, key: string}}
 */
function overpassAdmissionClass(req) {
  const peer = clientNetworkKey(req);
  if (!isLoopbackPeer(clientKey(req))) return { direct: false, key: peer };
  if (hasProxySignals(req.headers || {}))
    return { direct: false, key: `proxied:${peer}` };
  return { direct: true, key: peer };
}

/**
 * Spend one admission slot for this request; false when its bucket is over its
 * window (or, for remote traffic, when the shared global window is full).
 * @param {{direct: boolean, key: string}} admission - `overpassAdmissionClass(req)`.
 * @returns {boolean}
 */
function admitOverpassRequest({ direct, key }) {
  return (direct ? _overpassLoopbackAdmission : _overpassPeerAdmission)(key);
}

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

        // Keyless gate: refuses cross-site browser requests but, unlike the
        // cost-bearing routes, admits the forwarding headers a reverse proxy
        // adds — the layers that depend on Overpass must keep working for an
        // instance deployed the way the README documents.
        if (admitSameSiteKeyless(req, res)) return;
        const admission = overpassAdmissionClass(req);
        if (!admitOverpassRequest(admission)) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60',
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
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
          allowUpstream: () => _overpassRateLimiter(admission.key),
          loadUpstream: async () => {
            if (_overpassConcurrent >= OVERPASS_MAX_CONCURRENT)
              return {
                status: 503,
                contentType: 'application/json',
                retryAfterMs: 2000,
                body: JSON.stringify({
                  error: 'Overpass proxy busy — try again shortly',
                }),
              };
            _overpassConcurrent++;
            try {
              const payload = await fetchOverpassPayload(safeBody);
              if (overpassPayloadIsData(payload)) {
                const entry = { ...payload, cachedAt: Date.now() };
                _overpassCache.set(cacheKey, entry);
                trimOverpassCache();
                writeOverpassDisk(cacheKey, entry);
              }
              return payload;
            } finally {
              _overpassConcurrent--;
            }
          },
        });
        if (preflight.source === 'RATE_LIMITED') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
        if (!overpassPayloadIsData(preflight.payload)) {
          const stale = await readStaleOverpass(cacheKey);
          if (stale) {
            sendOverpassResponse(res, stale, 'STALE');
            return;
          }
        }
        // Preflight already published the disk hit to memory; only trim.
        if (preflight.source === 'DISK') trimOverpassCache();
        sendOverpassResponse(
          res,
          preflight.payload,
          preflight.source === 'UPSTREAM' ? 'MISS' : preflight.source,
        );
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
