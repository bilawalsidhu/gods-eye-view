import path from 'node:path';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { createBoundedCache } from '../common/boundedCache.js';
import {
  compileOsmFeatureQuery,
  OSM_FEATURE_LIMITS,
  summarizeOsmFeatures,
} from './osmFeatures.js';
import { resolveOverpassUpstreams } from './constants.js';
import { fetchOverpassPayload, overpassPayloadIsData } from './transport.js';

/** Places of interest change slowly: answers are kept a day. */
const OSM_FEATURES_TTL_MS = 86_400_000;
/** Cache-key version; nothing cached under another version is reused. */
const CACHE_VERSION = 'v2';

/** Never simplify: these answers are points and counts, not drawings. */
const keepBody = (body) => body;

const jsonError = (status, error, extra = {}) => ({
  status,
  body: JSON.stringify({ error, ...extra }),
});

/**
 * One upstream Overpass query at a time, with identical requests sharing it
 * and answers in a bounded memory + disk cache.
 */
function createOverpassAnswerer({
  fetchPayload,
  cache,
  maxResponseBytes,
  upstreamTimeoutMs,
}) {
  const inFlight = new Map();
  let running = 0;
  return async function answer(key, ql, summarize, signal = null) {
    signal?.throwIfAborted?.();
    const held = await cache.get(key);
    signal?.throwIfAborted?.();
    if (typeof held === 'string')
      return { status: 200, body: held, cache: 'HIT' };
    let operation = inFlight.get(key);
    if (operation?.controller.signal.aborted) {
      inFlight.delete(key);
      operation = null;
    }
    if (!operation) {
      if (running >= 1)
        return {
          ...jsonError(
            503,
            'Another map search is running — try again shortly.',
          ),
          retryAfter: '3',
        };
      running += 1;
      const controller = new AbortController();
      operation = { controller, waiters: 0, settled: false, promise: null };
      const owned = operation;
      owned.promise = (async () => {
        try {
          const payload = await fetchPayload(
            `data=${encodeURIComponent(ql)}`,
            maxResponseBytes,
            {
              simplify: keepBody,
              timeoutMs: upstreamTimeoutMs,
              signal: controller.signal,
            },
          );
          if (!overpassPayloadIsData(payload))
            return {
              ...jsonError(
                payload?.rateLimited ? 429 : 503,
                'OpenStreetMap search is unavailable right now.',
              ),
              retryAfter: '10',
            };
          let parsed;
          try {
            parsed = JSON.parse(payload.body);
          } catch {
            return jsonError(
              502,
              'OpenStreetMap returned an unreadable answer.',
            );
          }
          const body = JSON.stringify(summarize(parsed));
          controller.signal.throwIfAborted();
          await cache.set(key, body);
          controller.signal.throwIfAborted();
          return { status: 200, body, cache: 'MISS' };
        } catch {
          return jsonError(502, 'OpenStreetMap search failed.');
        } finally {
          owned.settled = true;
          running -= 1;
          if (inFlight.get(key) === owned) inFlight.delete(key);
        }
      })();
      inFlight.set(key, owned);
    }

    operation.waiters += 1;
    let abort = null;
    const abandoned = signal
      ? new Promise((_, reject) => {
          abort = () => {
            operation.waiters -= 1;
            if (operation.waiters === 0 && !operation.settled)
              operation.controller.abort();
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })
      : null;
    try {
      return await (abandoned
        ? Promise.race([operation.promise, abandoned])
        : operation.promise);
    } finally {
      if (signal && abort) signal.removeEventListener('abort', abort);
      if (!signal?.aborted) operation.waiters -= 1;
    }
  };
}

function sender(res) {
  return ({ status, body, cache, retryAfter }) => {
    if (res.writableEnded) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(cache ? { 'X-OSM-Cache': cache } : {}),
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
    });
    res.end(body);
  };
}

/**
 * Install `GET /api/osm/features?preset=&bbox=w,s,e,n[&mode=count][&limit=]`:
 * one curated preset inside a box, answered by the operator's Overpass
 * (`OVERPASS_UPSTREAMS`). With none configured the route answers
 * `OVERPASS_NOT_CONFIGURED` and fetches nothing; public Nominatim is never a
 * substitute for bulk place search.
 *
 * @param {{use: Function}} middlewares
 * @param {{fetchPayload?: Function, featuresCache?: object, cacheRoot?: string|null, configured?: () => boolean}} [deps]
 */
export function installOsmFeaturesRoute(
  middlewares,
  {
    fetchPayload = fetchOverpassPayload,
    configured = () => resolveOverpassUpstreams().length > 0,
    cacheRoot = path.join(process.cwd(), '.gev-cache'),
    featuresCache = createBoundedCache({
      dir: cacheRoot ? path.join(cacheRoot, 'osm-features') : null,
      ttlMs: OSM_FEATURES_TTL_MS,
      maxMemoryEntries: 60,
      maxDiskEntries: 400,
      maxDiskBytes: 256 * 1024 * 1024,
    }),
  } = {},
) {
  const limiter = makeRateLimiter({ windowMs: 60_000, max: 12, globalMax: 30 });
  const features = createOverpassAnswerer({
    fetchPayload,
    cache: featuresCache,
    maxResponseBytes: OSM_FEATURE_LIMITS.maxResponseBytes,
    upstreamTimeoutMs: OSM_FEATURE_LIMITS.upstreamTimeoutMs,
  });

  middlewares.use('/api/osm/features', async (req, res) => {
    const send = sender(res);
    if (req.method !== 'GET') return send(jsonError(405, 'Method Not Allowed'));
    if (!configured())
      return send(
        jsonError(503, 'Place search needs a configured Overpass server.', {
          code: 'OVERPASS_NOT_CONFIGURED',
          retryable: false,
        }),
      );
    const url = new URL(req.url || '', 'http://localhost');
    const compiled = compileOsmFeatureQuery({
      preset: url.searchParams.get('preset'),
      bbox: url.searchParams.get('bbox'),
      mode: url.searchParams.get('mode'),
      limit: url.searchParams.get('limit'),
    });
    if (!compiled.ok)
      return send(jsonError(400, compiled.error, { code: compiled.code }));
    if (!limiter(clientKey(req)))
      return send({
        ...jsonError(429, 'Rate limit exceeded'),
        retryAfter: '10',
      });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once?.('aborted', abort);
    res.once?.('close', abort);
    try {
      const answer = await features(
        `${CACHE_VERSION}|features|${compiled.ql}`,
        compiled.ql,
        (parsed) => summarizeOsmFeatures(parsed, compiled),
        controller.signal,
      );
      if (!controller.signal.aborted) send(answer);
    } catch {
      if (!controller.signal.aborted)
        send(jsonError(502, 'OpenStreetMap search failed.'));
    } finally {
      req.removeListener?.('aborted', abort);
      res.removeListener?.('close', abort);
    }
  });
}
