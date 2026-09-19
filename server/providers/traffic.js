import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  isValidTileCoord as isValidTomTomTile,
  utcDayKey as tomtomUtcDayKey,
  normalizeBudget as normalizeTomTomBudget,
  isOverBudget as isTomTomOverBudget,
} from '../../src/data/tomtomTiles.js';
import {
  PROVIDER_USER_AGENT,
  createLastGoodStore,
  fetchUpstreamJson,
  parseRetryAfter,
  providerStatus,
  statusHeaders,
} from './common/upstream.js';

const SOURCE = 'TomTom';
const TILE_BASE = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/';
const SEGMENT_BASE =
  'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/';
/** Status-body reason while keyless: the layer still runs, on simulated colours. */
const KEYLESS_STATUS_ERROR =
  'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads';
/** Data-route reason while keyless: there is nothing live to serve. */
const KEYLESS_ROUTE_ERROR =
  'TOMTOM_API_KEY not set — set it in Vercel to enable live traffic';
const BAD_KEY_ERROR = 'TomTom rejected TOMTOM_API_KEY';
const TILE_BUDGET_ERROR = 'TomTom daily tile budget reached';
const REQUEST_BUDGET_ERROR = 'TomTom daily request budget reached';

/** `lat,lon` query value → {lat, lon} or null when absent/invalid. */
function parsePoint(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (
    parts[0].trim() === '' ||
    parts[1].trim() === '' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return { lat, lon };
}

/** Milliseconds until the next UTC midnight (when the daily budgets reset). */
function msUntilUtcMidnight(now) {
  const d = new Date(now);
  return Math.max(
    1000,
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now,
  );
}

/** `Retry-After` header (whole seconds, ≥ 1) for a cooldown in ms; {} when none. */
function retryAfterHeader(ms) {
  return Number.isFinite(ms) && ms > 0
    ? { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) }
    : {};
}

const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * TomTom traffic proxy: flow vector tiles + flow-segment probes, with daily
 * budget governors and the structured provider status every MOVEMENT proxy
 * reports (server/providers/common/upstream.js).
 *
 * Routes (mounted at /api/tomtom):
 *
 *   GET /status[?point=lat,lon]
 *     { hasKey, dailyCount, budget, date, requestCount, requestBudget,
 *       provider, flowSegment? } — `provider` is `live` with a key and
 *     `degraded` without one (reason: TOMTOM_API_KEY not set …). With a key
 *     AND a point, a cheap Flow Segment probe (cached 60 s, so status polls
 *     do not burn budget) is attached as `flowSegment: { ok, currentSpeed,
 *     freeFlowSpeed, confidence, fetchedAt }` or `{ ok:false, error }` (then
 *     `provider` is `degraded` with the reason — a rejected key surfaces here
 *     before a single tile is fetched). Always no-store.
 *
 *   GET /flow-segment?point=lat,lon[&zoom=10][&unit=KMPH]
 *     TomTom Flow Segment Data (…/flowSegmentData/absolute/{zoom}/json) →
 *     { flowSegmentData, provider }, cached 60 s per point rounded to 0.01°
 *     (≤ 64 points), served from last-good as `stale` when upstream rate
 *     limits, times out or 5xxs. Keyless → 503 { error:'TOMTOM_API_KEY not
 *     set', provider }; upstream 401/403 → 503 'TomTom rejected
 *     TOMTOM_API_KEY'; 429 with nothing cached → 503 'TomTom rate limited
 *     (retry in Ns)' + Retry-After; timeout/5xx with nothing cached → 503
 *     'TomTom flow segment unreachable (…)'. Counted against
 *     TOMTOM_DAILY_REQUEST_BUDGET (default 2 000 — the free tier allows
 *     2 500 non-tile requests/day).
 *
 *   GET /flow/{z}/{x}/{y}.pbf
 *     Upstream …/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf (style
 *     `relative`; an UNCOMPRESSED Mapbox Vector Tile, layer "Traffic flow").
 *     Memory (≤ 256 tiles, last-good) + disk (.gev-cache/tomtom/) cache, TTL
 *     120 s, single-flight per tile; 10 s upstream timeout with one jittered
 *     (~300 ms) retry on network errors / 5xx only. A failed refresh serves
 *     the last-good tile with X-Provider-Status: stale; with nothing cached
 *     it answers 503 { error:'upstream', provider } — never a raw 502.
 *     Keyless → 503 { error:'no_key' }; upstream 401/403 → 503
 *     { error:'bad_key' }; over TOMTOM_DAILY_TILE_BUDGET (default 40 000 of
 *     the free tier's ~50k/day) → stale tile when available, else 429
 *     { error:'budget' }. Cache hits never count against the budget.
 *
 * Every JSON body carries `provider` and every response carries the
 * X-Provider-* headers (`statusHeaders`). The key comes from TOMTOM_API_KEY
 * server-side only and is never echoed — nor is any upstream URL or body.
 * Budgets persist in .gev-cache/tomtom/budget.json keyed by UTC date.
 *
 * @param {object} [options] test seams
 * @param {Function} [options.fetchImpl] defaults to globalThis.fetch at call time
 * @param {Function} [options.sleep]     retry delay (ms → Promise)
 * @param {Function} [options.random]    jitter source
 * @returns {import('vite').Plugin}
 */
export function tomtomProxy({ fetchImpl, sleep, random } = {}) {
  const TILE_TTL_MS = 120_000;
  const SEGMENT_TTL_MS = 60_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'tomtom');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  const DEFAULT_DAILY_BUDGET = 40000;
  const DEFAULT_DAILY_REQUEST_BUDGET = 2000;
  const MEM_MAX_ENTRIES = 256;
  const SEGMENT_MAX_ENTRIES = 64;
  const UPSTREAM_TIMEOUT_MS = 10000;
  const TILE_RETRIES = 1;

  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const doSleep =
    sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const doRandom = random || Math.random;
  /** ~300 ms with ±33 % jitter, for the single tile retry. */
  const tileRetryDelayMs = () => Math.round(200 + doRandom() * 200);

  /** Last-good tiles keyed `z/x/y` → { value: Buffer, fetchedAt } (kept past TTL for serve-stale). */
  const tiles = createLastGoodStore({ maxEntries: MEM_MAX_ENTRIES });
  /** @type {Map<string, Promise<{entry:object|null, error:{code:string,message:string}|null}>>} single-flight per tile. */
  const inflight = new Map();
  /** Last-good flow segments keyed by rounded point + zoom + unit. */
  const segments = createLastGoodStore({ maxEntries: SEGMENT_MAX_ENTRIES });
  /** @type {Map<string, Promise<object>>} single-flight per segment key. */
  const inflightSegments = new Map();

  /** @type {{date:string, count:number, requests?:number}|null} lazily-loaded persistent counters. */
  let budget = null;
  let budgetLoaded = false;

  function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
  }

  function requestBudgetLimit() {
    const raw = Number.parseInt(
      process.env.TOMTOM_DAILY_REQUEST_BUDGET || '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_REQUEST_BUDGET;
  }

  /** Redact the key from any text that could have come from a transport error. */
  function redact(text) {
    const key = process.env.TOMTOM_API_KEY;
    const value = String(text ?? '');
    return key ? value.split(key).join('[key]') : value;
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.date === 'string' &&
        Number.isFinite(parsed.count)
      ) {
        budget = parsed;
      }
    } catch {
      /* no budget file yet */
    }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn('[tomtom-proxy] budget write failed:', err?.message || err);
    }
  }

  /** Roll the counters to today (UTC) and return them. */
  function currentBudget() {
    budget = normalizeTomTomBudget(budget, tomtomUtcDayKey(Date.now()));
    if (!Number.isFinite(budget.requests) || budget.requests < 0)
      budget.requests = 0;
    return budget;
  }

  /** Count one upstream tile fetch attempt against today's tile budget (async persist). */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  /** Count `attempts` non-tile requests against today's request budget (async persist). */
  function recordRequests(attempts) {
    currentBudget().requests += Math.max(1, attempts | 0);
    void persistBudget();
  }

  function overRequestBudget() {
    return isTomTomOverBudget(
      { count: currentBudget().requests },
      requestBudgetLimit(),
    );
  }

  const tilePath = (key) =>
    path.join(CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);

  /** Disk-cache read; tile age comes from the file's mtime. */
  async function readDiskTile(key) {
    try {
      const [stat, buf] = await Promise.all([
        fsp.stat(tilePath(key)),
        fsp.readFile(tilePath(key)),
      ]);
      return { at: stat.mtimeMs, buf };
    } catch {
      return null;
    }
  }

  async function writeDiskTile(key, buf) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(tilePath(key), buf);
    } catch (err) {
      console.warn(
        `[tomtom-proxy] tile cache write failed for ${key}:`,
        err?.message || err,
      );
    }
  }

  const isTimeoutError = (err) =>
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    /TIMEOUT/i.test(String(err?.cause?.code || err?.code || ''));

  /**
   * Fetch one flow tile: binary body, 10 s timeout, one jittered retry on
   * network errors / timeouts / 5xx only (never on auth, 429 or other 4xx —
   * retrying those only burns budget). Never throws: `{ ok, buf, error }`.
   * Every attempt counts against the tile budget — upstream bills it either way.
   */
  async function fetchTile(z, x, y) {
    const url =
      TILE_BASE +
      `${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
    let lastError = { code: 'network', message: 'network error' };
    for (let attempt = 0; attempt <= TILE_RETRIES; attempt++) {
      if (attempt > 0) await doSleep(tileRetryDelayMs());
      recordUpstreamFetch();
      try {
        const res = await doFetch(url, {
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: {
            'User-Agent': PROVIDER_USER_AGENT,
            Accept: 'application/x-protobuf, */*',
          },
          redirect: 'follow',
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0) return { ok: true, buf, error: null };
          lastError = { code: 'empty', message: 'empty tile body' };
          continue;
        }
        try {
          await res.body?.cancel?.();
        } catch {
          /* ignore */
        }
        const status = Number(res.status) || 0;
        lastError = {
          code:
            status === 401 || status === 403
              ? 'auth'
              : status === 429
                ? 'rate_limited'
                : status >= 500
                  ? 'upstream_5xx'
                  : 'upstream_4xx',
          message: `HTTP ${status}`,
          retryAfterMs: parseRetryAfter(
            res.headers?.get?.('retry-after'),
            Date.now(),
          ),
        };
        if (!(status >= 500 || status === 408)) break;
      } catch (err) {
        lastError = isTimeoutError(err)
          ? {
              code: 'timeout',
              message: `timed out after ${UPSTREAM_TIMEOUT_MS} ms`,
            }
          : {
              code: 'network',
              message: redact(
                err?.cause?.code || err?.message || 'fetch failed',
              ).slice(0, 120),
            };
      }
    }
    return { ok: false, buf: null, error: lastError };
  }

  // ─── Flow Segment Data (point probe) ─────────────────────

  const segmentKey = (point, zoom, unit) =>
    `${point.lat.toFixed(2)},${point.lon.toFixed(2)}|${zoom}|${unit}`;

  const segmentFailure = (
    code,
    error,
    httpStatus = 503,
    retryAfterMs = null,
  ) => ({
    ok: false,
    data: null,
    fetchedAt: null,
    stale: false,
    cache: 'MISS',
    code,
    error,
    httpStatus,
    retryAfterMs,
  });

  const segmentStale = (cached, code, error, retryAfterMs = null) => ({
    ok: true,
    data: cached.value,
    fetchedAt: cached.fetchedAt,
    stale: true,
    cache: 'STALE',
    code,
    error,
    httpStatus: 200,
    retryAfterMs,
  });

  /** One upstream Flow Segment fetch (fetchUpstreamJson: 10 s, one retry), classified. */
  async function fetchSegment(key, point, zoom, unit) {
    const url =
      `${SEGMENT_BASE}${zoom}/json?point=${point.lat.toFixed(2)},${point.lon.toFixed(2)}` +
      `&unit=${unit}&key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
    const result = await fetchUpstreamJson(url, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      retries: 1,
      maxBytes: 1024 * 1024,
      label: SOURCE,
      ...(fetchImpl ? { fetchImpl } : {}),
      sleep: doSleep,
      random: doRandom,
    });
    recordRequests(result.attempts);
    if (result.ok) {
      const data = result.json?.flowSegmentData;
      if (!data || typeof data !== 'object')
        return segmentFailure(
          'malformed',
          'TomTom returned malformed flow segment data',
        );
      const entry = segments.set(key, data, {
        fetchedAt: Date.now(),
        source: SOURCE,
      });
      return {
        ok: true,
        data,
        fetchedAt: entry.fetchedAt,
        stale: false,
        cache: 'MISS',
        code: null,
        error: null,
        httpStatus: 200,
        retryAfterMs: null,
      };
    }
    const code = result.error?.code || 'network';
    const status = Number(result.status) || 0;
    switch (code) {
      case 'auth':
        return segmentFailure('auth', BAD_KEY_ERROR);
      case 'rate_limited': {
        const retryAfterMs = result.retryAfterMs ?? 30_000;
        return segmentFailure(
          'rate_limited',
          `TomTom rate limited (retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s)`,
          503,
          retryAfterMs,
        );
      }
      case 'timeout':
        return segmentFailure(
          'timeout',
          `TomTom flow segment unreachable (timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} s)`,
        );
      case 'upstream_5xx':
        return segmentFailure(
          'upstream',
          `TomTom flow segment unreachable (HTTP ${status})`,
        );
      case 'upstream_4xx':
        // The request itself was refused (typically no road segment near the
        // point) — a caller problem, not an outage; never served from last-good.
        return segmentFailure(
          'rejected',
          `TomTom rejected the flow segment request (HTTP ${status})`,
          400,
        );
      case 'malformed':
        return segmentFailure(
          'malformed',
          'TomTom returned malformed flow segment data',
        );
      case 'too_large':
        return segmentFailure(
          'malformed',
          'TomTom flow segment response too large',
        );
      default:
        return segmentFailure(
          'network',
          'TomTom flow segment unreachable (network error)',
        );
    }
  }

  /**
   * Flow segment for a point: fresh cache (60 s) → budget governor →
   * single-flight upstream fetch → last-good on failure. Never throws.
   */
  async function getFlowSegment(point, { zoom = 10, unit = 'KMPH' } = {}) {
    const key = segmentKey(point, zoom, unit);
    const now = Date.now();
    const cached = segments.get(key);
    if (cached && now - cached.fetchedAt < SEGMENT_TTL_MS) {
      return {
        ok: true,
        data: cached.value,
        fetchedAt: cached.fetchedAt,
        stale: false,
        cache: 'HIT',
        code: null,
        error: null,
        httpStatus: 200,
        retryAfterMs: null,
      };
    }
    if (overRequestBudget()) {
      const retryAfterMs = msUntilUtcMidnight(now);
      return cached
        ? segmentStale(cached, 'budget', REQUEST_BUDGET_ERROR, retryAfterMs)
        : segmentFailure('budget', REQUEST_BUDGET_ERROR, 503, retryAfterMs);
    }
    if (!inflightSegments.has(key)) {
      inflightSegments.set(
        key,
        fetchSegment(key, point, zoom, unit).finally(() =>
          inflightSegments.delete(key),
        ),
      );
    }
    const result = await inflightSegments.get(key);
    if (result.ok) return result;
    if (cached && result.code !== 'rejected')
      return segmentStale(
        cached,
        result.code,
        result.error,
        result.retryAfterMs,
      );
    return result;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/tomtom', async (req, res) => {
      // Sanitized responses only (proxy/security baseline): no upstream
      // error details, and never echo the key or the upstream URL.
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      /** Tile bytes + provider status: fresh tiles may sit on the edge for 60 s; stale ones never. */
      const sendTile = (entry, cacheStatus, staleReason = null) => {
        if (res.headersSent) return;
        const stale = cacheStatus.startsWith('STALE');
        const provider = providerStatus({
          status: stale ? 'stale' : 'live',
          source: SOURCE,
          fetchedAt: entry.fetchedAt,
          error: stale ? staleReason : null,
          now: Date.now(),
        });
        res.writeHead(200, {
          'Content-Type': 'application/x-protobuf',
          ...statusHeaders(
            provider,
            stale ? null : { edgeMaxAgeSec: 60, staleWhileRevalidateSec: 120 },
          ),
          'x-tomtom-cache': cacheStatus,
        });
        res.end(entry.value);
      };
      /** Structured failure: HTTP `status`, `{ error, provider }` body, provider headers. */
      const sendUnavailable = (
        status,
        error,
        reason,
        { retryAfterMs = null, extra = {} } = {},
      ) => {
        const provider = providerStatus({
          status: 'unavailable',
          source: SOURCE,
          error: reason,
          now: Date.now(),
        });
        sendJson(
          status,
          { error, provider, ...extra },
          { ...statusHeaders(provider), ...retryAfterHeader(retryAfterMs) },
        );
      };

      try {
        await loadBudgetOnce();
        const [urlPath, query = ''] = String(req.url || '').split('?');
        const params = new URLSearchParams(query);
        const hasKey = Boolean(process.env.TOMTOM_API_KEY);

        if (urlPath === '/status') {
          const now = Date.now();
          let provider = providerStatus({
            status: hasKey ? 'live' : 'degraded',
            source: SOURCE,
            fetchedAt: now,
            error: hasKey ? null : KEYLESS_STATUS_ERROR,
            now,
          });
          const body = { hasKey };
          const point = parsePoint(params.get('point'));
          if (hasKey && point) {
            // Cheap probe through the 60 s segment cache: proves the key and
            // samples live speed at the scene without burning tile budget.
            const probe = await getFlowSegment(point, {
              zoom: 10,
              unit: 'KMPH',
            });
            if (probe.ok) {
              body.flowSegment = {
                ok: true,
                currentSpeed: finiteOrNull(probe.data.currentSpeed),
                freeFlowSpeed: finiteOrNull(probe.data.freeFlowSpeed),
                confidence: finiteOrNull(probe.data.confidence),
                roadClosure: probe.data.roadClosure === true,
                fetchedAt: new Date(probe.fetchedAt).toISOString(),
                stale: probe.stale,
              };
              provider = providerStatus({
                status: probe.stale ? 'stale' : 'live',
                source: SOURCE,
                fetchedAt: probe.fetchedAt,
                error: probe.stale ? probe.error : null,
                now,
              });
            } else {
              body.flowSegment = { ok: false, error: probe.error };
              // A refused point (no road nearby) says nothing about the feed;
              // auth / rate limit / timeout / budget do.
              if (probe.code !== 'rejected')
                provider = providerStatus({
                  status: 'degraded',
                  source: SOURCE,
                  fetchedAt: now,
                  error: probe.error,
                  now,
                });
            }
          }
          // Counters are read AFTER the probe so a status poll reports the
          // request it just spent (or the cache hit it did not).
          const b = currentBudget();
          Object.assign(body, {
            dailyCount: b.count,
            budget: dailyBudgetLimit(),
            date: b.date,
            requestCount: b.requests,
            requestBudget: requestBudgetLimit(),
            provider,
          });
          sendJson(200, body, statusHeaders(provider));
          return;
        }

        if (urlPath === '/flow-segment') {
          const point = parsePoint(params.get('point'));
          if (!point) {
            sendJson(400, { error: 'invalid_point' });
            return;
          }
          const zoomRaw = params.get('zoom');
          const zoom = zoomRaw == null || zoomRaw === '' ? 10 : Number(zoomRaw);
          if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
            sendJson(400, { error: 'invalid_zoom' });
            return;
          }
          const unit = String(params.get('unit') || 'KMPH').toUpperCase();
          if (!['KMPH', 'MPH'].includes(unit)) {
            sendJson(400, { error: 'invalid_unit' });
            return;
          }
          if (!hasKey) {
            sendUnavailable(503, 'TOMTOM_API_KEY not set', KEYLESS_ROUTE_ERROR);
            return;
          }
          const result = await getFlowSegment(point, { zoom, unit });
          if (result.ok) {
            const provider = providerStatus({
              status: result.stale ? 'stale' : 'live',
              source: SOURCE,
              fetchedAt: result.fetchedAt,
              error: result.stale ? result.error : null,
              now: Date.now(),
            });
            sendJson(
              200,
              { flowSegmentData: result.data, provider },
              {
                ...statusHeaders(
                  provider,
                  result.stale
                    ? null
                    : { edgeMaxAgeSec: 60, staleWhileRevalidateSec: 300 },
                ),
                ...(result.stale ? retryAfterHeader(result.retryAfterMs) : {}),
                'x-tomtom-cache': result.cache,
              },
            );
            return;
          }
          sendUnavailable(
            result.httpStatus || 503,
            result.error,
            result.error,
            {
              retryAfterMs: result.retryAfterMs,
            },
          );
          return;
        }

        const m = urlPath.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (!isValidTomTomTile(z, x, y)) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        if (!hasKey) {
          sendUnavailable(503, 'no_key', KEYLESS_ROUTE_ERROR);
          return;
        }

        const key = `${z}/${x}/${y}`;
        const now = Date.now();

        let entry = tiles.get(key);
        if (!entry) {
          const disk = await readDiskTile(key);
          if (disk)
            entry = tiles.set(key, disk.buf, {
              fetchedAt: disk.at,
              source: SOURCE,
            });
        }
        // Fresh cache hit — never counts against the budget.
        if (entry && now - entry.fetchedAt < TILE_TTL_MS) {
          sendTile(entry, 'HIT');
          return;
        }

        // Budget governor: over the soft cap, last-good data beats a dead layer.
        if (isTomTomOverBudget(currentBudget(), dailyBudgetLimit())) {
          if (entry) {
            sendTile(entry, 'STALE-BUDGET', TILE_BUDGET_ERROR);
          } else {
            sendUnavailable(429, 'budget', TILE_BUDGET_ERROR, {
              retryAfterMs: msUntilUtcMidnight(now),
            });
          }
          return;
        }

        // Stale or missing → refresh, single-flight per tile.
        if (!inflight.has(key)) {
          inflight.set(
            key,
            fetchTile(z, x, y)
              .then(async ({ ok, buf, error }) => {
                if (!ok) {
                  console.warn(
                    `[tomtom-proxy] ${key} fetch failed (${error.message}) — serving stale if any`,
                  );
                  return { entry: null, error };
                }
                const fresh = tiles.set(key, buf, {
                  fetchedAt: Date.now(),
                  source: SOURCE,
                });
                await writeDiskTile(key, buf);
                return { entry: fresh, error: null };
              })
              .finally(() => inflight.delete(key)),
          );
        }
        const outcome = await inflight.get(key);
        const failure = outcome.error;
        const reason =
          failure?.code === 'auth'
            ? BAD_KEY_ERROR
            : failure?.code === 'rate_limited'
              ? `TomTom rate limited (retry in ${Math.max(1, Math.ceil((failure.retryAfterMs ?? 30_000) / 1000))}s)`
              : `TomTom flow tile unreachable (${failure?.message || 'unknown error'})`;
        if (outcome.entry) {
          sendTile(outcome.entry, 'MISS');
        } else if (entry) {
          sendTile(entry, 'STALE-ERROR', reason); // upstream down — stale beats empty
        } else if (failure?.code === 'auth') {
          sendUnavailable(503, 'bad_key', reason);
        } else if (failure?.code === 'rate_limited') {
          sendUnavailable(503, 'rate_limited', reason, {
            retryAfterMs: failure.retryAfterMs ?? 30_000,
          });
        } else {
          sendUnavailable(503, 'upstream', reason);
        }
      } catch (err) {
        console.warn('[tomtom-proxy] error:', err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };
  return {
    name: 'tomtom-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
