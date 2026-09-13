/**
 * Overpass road-geometry proxy (`/api/overpass` + `/api/route`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import path from 'node:path';
import { clientKey, makeRateLimiter, readResponseTextCapped } from './_shared.js';
import { createHash } from 'node:crypto';
import { fetchOverpassPayload, sanitizeOverpassBody } from '../../src/data/overpassPolicy.js';
import {
  ROUTE_CACHE_MAX_ENTRIES,
  ROUTE_CACHE_MS,
  ROUTE_MAX_RESPONSE_BYTES,
  ROUTE_UPSTREAM_TIMEOUT_MS,
  buildOsrmUrl,
  normalizeRouteProfile,
  osrmRoutePayload,
  parseRouteCoords,
  routeSpanError,
} from '../../src/data/routePolicy.js';
import { promises as fsp } from 'node:fs';

// ---------------------------------------------------------------------------
// Overpass API proxy constants and cache state
// ---------------------------------------------------------------------------
/**
 * TTL for FRESH cached Overpass responses (ms). Road geometry is static for
 * months — the original 45 s TTL forced a public-mirror round-trip on nearly
 * every viewport revisit and left nothing to serve when the mirrors 502
 * (field-test 2026-07-17: all three mirrors down during US morning peak =
 * "traffic takes forever to load"). 24 h in memory; the disk layer below
 * keeps 7 days and also survives dev-server restarts.
 */
export const OVERPASS_CACHE_MS = 86_400_000;

/** Disk-cache TTL for Overpass responses (ms) — 7 days. */
export const OVERPASS_DISK_TTL_MS = 7 * 86_400_000;

/**
 * Disk-cache TTL for BOUNDARY-class queries (is_in / admin-relation pivots) — 30
 * days. Admin boundaries change ≈never, and their pivots are the most expensive
 * queries the app issues (multi-MB coastline geometry, 10–25 s on public mirrors —
 * field test 2026-07-23: outline latency + the Sicily miss). Keeping them a month
 * means each boundary is fetched roughly once per machine, ever.
 */
export const OVERPASS_BOUNDARY_DISK_TTL_MS = 30 * 86_400_000;

/** Disk-cache directory for Overpass responses. */
export const OVERPASS_DISK_DIR = path.join(process.cwd(), '.gev-cache', 'overpass');

/** Max entries in the Overpass response cache (LRU-like, oldest evicted first). */
export const OVERPASS_CACHE_MAX_ENTRIES = 120;

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
export const _overpassCache = new Map();

/** @type {Map<string,Promise>} In-flight Overpass requests keyed by normalized query body. */
export const _overpassInFlight = new Map();

/**
 * Whether a normalized Overpass query is BOUNDARY-class (admin `is_in` lookups
 * and area→relation pivots) — the static, expensive geometry that earns the
 * 30-day disk TTL. The enclosing-compound sweep and road fetches keep the
 * default TTL. Exported for tests.
 */
export function isOverpassBoundaryQuery(cacheKey) {
  return /is_in\s*\(|\bpivot\b/i.test(String(cacheKey || ''));
}

/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */
export function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey) ? OVERPASS_BOUNDARY_DISK_TTL_MS : OVERPASS_DISK_TTL_MS;
}

/** Normalized Overpass query -> stable disk-cache file path. */
export function overpassDiskPath(cacheKey) {
  return path.join(OVERPASS_DISK_DIR, `${createHash('sha1').update(cacheKey).digest('hex')}.json`);
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */
export async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (!payload || typeof payload.body !== 'string' || !Number.isFinite(payload.cachedAt)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Fire-and-forget disk write for a successful Overpass payload. */
export function writeOverpassDisk(cacheKey, payload) {
  fsp.mkdir(OVERPASS_DISK_DIR, { recursive: true })
    .then(() => fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)))
    .catch((err) => console.warn('[Overpass Proxy] disk cache write failed:', err?.message || err));
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */
export async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= cacheMs) return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (disk) return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}

/** OSM routing (FOSSGIS OSRM) cache: profile|coords -> { payload, cachedAt }.
 *  TTL, response cap and span abuse limits live in the shared
 *  `src/data/routePolicy.js` (imported above) so the Pages Function at
 *  `functions/api/route.js` cannot drift from this middleware. */
export const _routeCache = new Map();

// --- Abuse guards shared by the Overpass + route proxies --------------------
/** Max accepted POST body for the Overpass proxy (Overpass QL queries are tiny). */
export const OVERPASS_MAX_BODY_BYTES = 24 * 1024; // 24 KB

/** Max concurrent in-flight upstream Overpass fetches across all distinct queries. */
export const OVERPASS_MAX_CONCURRENT = 6;

export let _overpassConcurrent = 0;

export const _overpassRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });

export const _routeRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 200 });

/** Read a request body with a hard byte cap; throws { code:'BODY_TOO_LARGE' } past the cap. */
export async function readRequestBodyCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Evict oldest Overpass cache entries until size is within the cap. */
export function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

/**
 * Write a completed Overpass payload to the HTTP response.
 *
 * @param {import('http').ServerResponse} res - Node HTTP response.
 * @param {{status:number,body:string,contentType:string,endpoint:string}} payload
 * @param {string} [cacheStatus='MISS'] - 'HIT', 'MISS', or 'INFLIGHT'.
 */
export function sendOverpassResponse(res, payload, cacheStatus = 'MISS') {
  res.writeHead(payload.status, {
    'Content-Type': payload.contentType || 'application/json',
    'Cache-Control': 'public, max-age=15',
    'X-Overpass-Cache': cacheStatus,
    'X-Overpass-Upstream': payload.endpoint || 'unknown',
  });
  res.end(payload.body || '');
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
export function overpassProxy() {
  return {
    name: 'overpass-proxy',
    configureServer(server) {
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
            body = (await readRequestBodyCapped(req, OVERPASS_MAX_BODY_BYTES)).toString();
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
            readDisk: () => readOverpassDisk(cacheKey, overpassDiskTtlMs(cacheKey)),
            allowUpstream: () => _overpassRateLimiter(clientKey(req)),
          });
          if (preflight.source === 'RATE_LIMITED') {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
            return;
          }
          if (preflight.source !== 'UPSTREAM') {
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
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
            res.end(JSON.stringify({ error: 'Overpass proxy busy — try again shortly' }));
            return;
          }
          _overpassConcurrent += 1;
          const requestPromise = fetchOverpassPayload(safeBody)
            .then((payload) => {
              if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
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
          if (payload.rateLimited || payload.runtimeError || payload.status >= 500) {
            const stale = _overpassCache.get(cacheKey) || await readOverpassDisk(cacheKey, Infinity);
            if (stale) {
              sendOverpassResponse(res, stale, 'STALE');
              return;
            }
          }
          sendOverpassResponse(res, payload, 'MISS');
        } catch (e) {
          // Every mirror threw (network-level). Same serve-stale rule.
          const stale = cacheKey
            ? (_overpassCache.get(cacheKey) || await readOverpassDisk(cacheKey, Infinity).catch(() => null))
            : null;
          if (stale) {
            sendOverpassResponse(res, stale, 'STALE');
            return;
          }
          console.error('[Overpass Proxy]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Overpass proxy error' }));
        }
      });

      // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
      // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
      // Validation, span limits and the upstream URL live in the shared
      // `src/data/routePolicy.js` (worker-safe) — functions/api/route.js runs
      // the same policy on Pages so the two runtimes cannot drift.
      server.middlewares.use('/api/route', async (req, res) => {
        const fail = (msg) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: msg }));
        };
        try {
          if (!_routeRateLimiter(clientKey(req))) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
            return;
          }
          const url = new URL(req.url, 'http://localhost');
          const profile = normalizeRouteProfile(url.searchParams.get('profile'));
          if (!profile) return fail('invalid profile');
          const parsed = parseRouteCoords(url.searchParams.get('coords'));
          if (!parsed.ok) return fail(parsed.error);
          const spanError = routeSpanError(parsed.pts);
          if (spanError) return fail(spanError);
          const coords = parsed.coords;
          const cacheKey = `${profile}|${coords}`;
          const now = Date.now();
          const cached = _routeCache.get(cacheKey);
          if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cached.payload));
            return;
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ROUTE_UPSTREAM_TIMEOUT_MS);
          let osrm;
          try {
            const upstreamRes = await fetch(buildOsrmUrl(profile, coords), {
              signal: controller.signal,
              headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
            });
            if (!upstreamRes.ok) return fail('no route found');
            const ctype = upstreamRes.headers.get('content-type') || '';
            if (!ctype.includes('json')) return fail('no route found');
            const text = await readResponseTextCapped(upstreamRes, ROUTE_MAX_RESPONSE_BYTES);
            osrm = JSON.parse(text);
          } finally {
            clearTimeout(timer);
          }
          const payload = osrmRoutePayload(osrm, profile);
          if (!payload.ok) return fail(payload.error);
          _routeCache.set(cacheKey, { payload, cachedAt: now });
          if (_routeCache.size > ROUTE_CACHE_MAX_ENTRIES) _routeCache.delete(_routeCache.keys().next().value);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        } catch (e) {
          console.error('[Route Proxy]', e?.message || e);
          fail('route proxy error');
        }
      });
    },
  };
}
