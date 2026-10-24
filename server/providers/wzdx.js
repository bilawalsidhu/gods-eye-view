import { gzipSync } from 'node:zlib';
import {
  eventVertexCount,
  normalizeWzdxFeed,
} from '../../src/layers/workZones/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/**
 * US state DOT WZDx WorkZoneFeeds, fixed in code: the browser never names a
 * feed or a URL (SECURITY.md). Each one is keyless and states the CC0 1.0
 * licence in its own feed header (`feed_info.license`), as the WZDx spec asks
 * of public feeds. DATA_SOURCES.md records where each URL is published.
 */
export const WZDX_FEEDS = Object.freeze(
  [
    {
      id: 'mn',
      name: 'Minnesota',
      publisher: 'Minnesota DOT',
      url: 'https://mn.carsprogram.org/carsapi_v1/api/wzdx',
    },
    {
      id: 'in',
      name: 'Indiana',
      publisher: 'Indiana DOT',
      url: 'https://in.carsprogram.org/carsapi_v1/api/wzdx',
    },
    {
      id: 'ks',
      name: 'Kansas',
      publisher: 'Kansas DOT',
      url: 'https://kscars.kandrive.gov/carsapi_v1/api/wzdx',
    },
    {
      id: 'nd',
      name: 'North Dakota',
      publisher: 'North Dakota DOT',
      url: 'https://travelfiles.dot.nd.gov/geojson_nc/wzdx_geojson.json',
    },
    {
      id: 'md',
      name: 'Maryland',
      publisher: 'Maryland DOT SHA',
      url: 'https://filter.ritis.org/wzdx_v4.1/mdot.geojson',
    },
    {
      id: 'ky',
      name: 'Kentucky',
      publisher: 'Kentucky Transportation Cabinet',
      url: 'https://storage.googleapis.com/kytc-its-2020-openrecords/public/feeds/WZDx/kytc_wzdx_v4.1.geojson',
    },
    {
      id: 'ms',
      name: 'Mississippi',
      publisher: 'Mississippi DOT',
      url: 'https://api.mdottraffic.com/prod/v3/data/wzdx',
    },
    {
      id: 'az-maricopa',
      name: 'Maricopa County (Arizona)',
      publisher: 'Maricopa County DOT',
      url: 'https://wzdxapi.aztech.org/construction',
    },
  ].map((feed) => Object.freeze(feed)),
);

/** One shared snapshot for every client, rebuilt at most this often. */
export const WZDX_REFRESH_MS = 5 * 60_000;
/** A failed feed keeps its last good events this long, then reads unavailable. */
export const WZDX_STALE_LIMIT_MS = 6 * 3600_000;
/** After a refresh that left no data at all, wait this long before retrying. */
export const WZDX_FAILURE_BACKOFF_MS = 60_000;
export const WZDX_FEED_TIMEOUT_MS = 30_000;
/** Indiana, the largest, sends ~4.3 MB; the cap leaves room to grow. */
export const WZDX_FEED_MAX_BYTES = 16 * 1024 * 1024;
/** Whole-snapshot line budget; events past it keep only their marker. */
export const WZDX_SNAPSHOT_MAX_VERTICES = 60_000;
const USER_AGENT = 'gods-eye-view-wzdx/1.0';

/** A fixed failure code: transport text never reaches the browser. */
function failureCode(error) {
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'too_large';
  if (error?.code === 'unsupported_version') return 'unsupported_version';
  if (error?.code === 'invalid' || error instanceof SyntaxError)
    return 'invalid';
  if (Number.isInteger(error?.status)) return `http_${error.status}`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
    return 'timeout';
  return 'network';
}

/** Fixed-origin, shared-snapshot WZDx route for dev and preview. */
export function wzdxProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  feeds = WZDX_FEEDS,
  warn = (...args) => console.warn(...args),
} = {}) {
  /** Last good read per feed: { events, fetchedAt, version, counts }. */
  const good = new Map();
  /** Last attempt per feed: { at, code }. */
  const attempts = new Map();
  const inFlight = new Map();
  let snapshot = null;
  let lastRefreshAt = 0;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function readFeed(feed) {
    const signal = AbortSignal.timeout(WZDX_FEED_TIMEOUT_MS);
    const response = await fetchImpl(feed.url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error('upstream_status'), {
        status: response.status,
      });
    }
    const payload = await readResponseJsonCapped(
      response,
      WZDX_FEED_MAX_BYTES,
      signal,
    );
    return normalizeWzdxFeed(payload, feed, { now: now() });
  }

  function build(builtAt) {
    const feedRows = [];
    const events = [];
    let vertices = 0;
    let linesDropped = 0;
    for (const feed of feeds) {
      const last = good.get(feed.id);
      const attempt = attempts.get(feed.id);
      const fresh = last && attempt?.code === null;
      const usable = last && builtAt - last.fetchedAt <= WZDX_STALE_LIMIT_MS;
      feedRows.push({
        id: feed.id,
        name: feed.name,
        publisher: feed.publisher,
        status: fresh ? 'live' : usable ? 'stale' : 'unavailable',
        fetchedAt: usable ? last.fetchedAt : null,
        version: usable ? last.version : null,
        count: usable ? last.events.length : 0,
        error: attempt?.code ?? null,
      });
      if (!usable) continue;
      for (const event of last.events) {
        const size = eventVertexCount([event]);
        if (vertices + size > WZDX_SNAPSHOT_MAX_VERTICES) {
          linesDropped++;
          events.push({ ...event, lines: [] });
          continue;
        }
        vertices += size;
        events.push(event);
      }
    }
    const body = JSON.stringify({
      builtAt,
      feeds: feedRows,
      events,
      vertices,
      linesDropped,
    });
    return {
      builtAt,
      hasData: feedRows.some((row) => row.status !== 'unavailable'),
      body,
      gzip: gzipSync(body),
      feeds: feedRows,
    };
  }

  async function refresh() {
    const startedAt = now();
    lastRefreshAt = startedAt;
    const results = await Promise.allSettled(feeds.map(readFeed));
    const at = now();
    results.forEach((result, index) => {
      const feed = feeds[index];
      if (result.status === 'fulfilled') {
        good.set(feed.id, { ...result.value, fetchedAt: at });
        attempts.set(feed.id, { at, code: null });
      } else {
        const code = failureCode(result.reason);
        attempts.set(feed.id, { at, code });
        warn(`[wzdx] ${feed.id} refresh failed: ${code}`);
      }
    });
    snapshot = build(at);
    return snapshot;
  }

  function due() {
    const t = now();
    if (!snapshot) return t - lastRefreshAt >= WZDX_FAILURE_BACKOFF_MS;
    if (!snapshot.hasData) return t - lastRefreshAt >= WZDX_FAILURE_BACKOFF_MS;
    return t - snapshot.builtAt >= WZDX_REFRESH_MS;
  }

  function startRefresh() {
    return coalesceProxyRequest(inFlight, 'snapshot', refresh).promise;
  }

  async function current() {
    // Stale-while-revalidate: an existing snapshot answers at once, and a due
    // refresh runs behind it for the next poll. Only the first read waits.
    if (snapshot?.hasData) {
      if (due() && !inFlight.size)
        startRefresh().catch((error) =>
          warn('[wzdx] refresh failed:', failureCode(error)),
        );
      return snapshot;
    }
    if (inFlight.size || due()) return startRefresh();
    return snapshot;
  }

  async function handler(req, res) {
    const send = (status, body, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(body);
    };
    const error = (status, code, headers) =>
      send(status, JSON.stringify({ error: code }), headers);
    if (req.method !== 'GET')
      return error(405, 'method_not_allowed', { Allow: 'GET' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/events') return error(404, 'unknown_route');
    if (!allow(clientKey(req)))
      return error(429, 'rate_limited', { 'Retry-After': '60' });
    let value;
    try {
      value = await current();
    } catch (failure) {
      warn('[wzdx] snapshot failed:', failureCode(failure));
      value = snapshot;
    }
    if (!value?.hasData) {
      const wait = Math.max(
        5,
        Math.ceil((lastRefreshAt + WZDX_FAILURE_BACKOFF_MS - now()) / 1000),
      );
      return error(503, 'wzdx_unavailable', { 'Retry-After': String(wait) });
    }
    const headers = { 'X-Snapshot-Age': String(now() - value.builtAt) };
    if (/\bgzip\b/.test(String(req.headers?.['accept-encoding'] || '')))
      return send(200, value.gzip, {
        ...headers,
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
      });
    send(200, value.body, headers);
  }

  return {
    name: 'wzdx',
    configureServer({ middlewares }) {
      middlewares.use('/api/wzdx', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wzdx', handler);
    },
  };
}
