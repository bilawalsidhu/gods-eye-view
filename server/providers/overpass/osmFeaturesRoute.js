import path from 'node:path';
import { makeRateLimiter, clientNetworkKey } from '../common/rate-limit.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { createBoundedCache } from '../common/boundedCache.js';
import {
  compileOsmFeatureQuery,
  OSM_FEATURE_LIMITS,
  summarizeOsmFeatures,
} from './osmFeatures.js';
import {
  resolveOverpassUpstreams,
  resolveOverpassUpstreamTag,
} from './constants.js';
import { fetchOverpassPayload, overpassPayloadIsData } from './transport.js';

/** Places of interest change slowly: answers are kept a day. */
const OSM_FEATURES_TTL_MS = 86_400_000;
/** Upstream searches at once, across all clients (one per client). */
const OSM_MAX_RUNNING = 2;
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
  upstreamBudgetMs,
  maxRunning = OSM_MAX_RUNNING,
}) {
  const inFlight = new Map();
  // One search per client, a few in all: one client can't hold the route.
  const runningBy = new Map();
  let running = 0;
  return async function answer(key, ql, summarize, signal = null, owner = '') {
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
      if (runningBy.get(owner) || running >= maxRunning)
        return {
          ...jsonError(
            503,
            runningBy.get(owner)
              ? 'Your previous map search is still running — try again shortly.'
              : 'Another map search is running — try again shortly.',
          ),
          retryAfter: '3',
        };
      running += 1;
      runningBy.set(owner, (runningBy.get(owner) || 0) + 1);
      const controller = new AbortController();
      // The whole search, every configured endpoint in turn, gets one budget.
      const budget = AbortSignal.timeout(upstreamBudgetMs);
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
              signal: AbortSignal.any([controller.signal, budget]),
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
          return budget.aborted && !controller.signal.aborted
            ? jsonError(504, 'OpenStreetMap took too long to answer.')
            : jsonError(502, 'OpenStreetMap search failed.');
        } finally {
          owned.settled = true;
          running -= 1;
          const left = (runningBy.get(owner) || 1) - 1;
          if (left > 0) runningBy.set(owner, left);
          else runningBy.delete(owner);
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
 * @param {{fetchPayload?: Function, featuresCache?: object, cacheRoot?: string|null, configured?: () => boolean, upstreamTag?: () => string}} [deps]
 */
export function installOsmFeaturesRoute(
  middlewares,
  {
    fetchPayload = fetchOverpassPayload,
    configured = () => resolveOverpassUpstreams().length > 0,
    // Keys each answer to the instance that gave it, as the other Overpass
    // caches do, so repointing OVERPASS_UPSTREAMS never serves the old one's.
    upstreamTag = resolveOverpassUpstreamTag,
    upstreamBudgetMs = OSM_FEATURE_LIMITS.upstreamBudgetMs,
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
    upstreamBudgetMs,
  });

  middlewares.use('/api/osm/features', async (req, res) => {
    const send = sender(res);
    if (req.method !== 'GET') return send(jsonError(405, 'Method Not Allowed'));
    // A page elsewhere must not spend the operator's Overpass. The keyless
    // gate, as on /api/overpass: voice works behind a reverse proxy too.
    if (admitSameSiteKeyless(req, res)) return undefined;
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
    // IPv6 peers by /64, as /api/overpass does: rotating addresses inside
    // one prefix earns neither a second rate bucket nor a second slot.
    const client = clientNetworkKey(req);
    if (!limiter(client))
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
        `${CACHE_VERSION}|features|${upstreamTag()}|${compiled.ql}`,
        compiled.ql,
        (parsed) => summarizeOsmFeatures(parsed, compiled),
        controller.signal,
        client,
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
