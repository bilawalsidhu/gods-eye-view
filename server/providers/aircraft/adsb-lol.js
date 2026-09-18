import { coalesceProxyRequest } from '../common/http.js';
import {
  createLastGoodStore,
  distanceNm,
  fetchUpstream,
  providerStatus,
  queryNumber,
  statusHeaders,
} from '../common/upstream.js';

const ADSBLOL_MIL_URL = 'https://api.adsb.lol/v2/mil';
const ADSBFI_MIL_URL = 'https://opendata.adsb.fi/api/v2/mil';
const AIRPLANES_LIVE_MIL_URL = 'https://api.airplanes.live/v2/mil';
const adsbLolPointUrl = (lat, lon, nm) =>
  `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const POINT_MAX_RADIUS_NM = 250;
const FILTER_MAX_RADIUS_NM = 5000;
/** adsb.fi asks for at most one request per second per endpoint (module-scoped: every instance shares it). */
const ADSBFI_MIN_INTERVAL_MS = 1000;
const ADSBFI_MAX_WAIT_MS = 3000;
let _adsbFiNextSlot = 0;

/** Reserve the next adsb.fi request slot; false when the queue is too long. */
async function adsbFiSlot() {
  const now = Date.now();
  // Slots are only ever reserved a few seconds ahead; a reservation further
  // out means the clock moved backwards (tests, NTP) — start over.
  if (_adsbFiNextSlot - now > ADSBFI_MAX_WAIT_MS + ADSBFI_MIN_INTERVAL_MS)
    _adsbFiNextSlot = now;
  const slot = Math.max(now, _adsbFiNextSlot);
  const wait = slot - now;
  if (wait > ADSBFI_MAX_WAIT_MS) return false;
  _adsbFiNextSlot = slot + ADSBFI_MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return true;
}

const airplanesLiveEnabled = () =>
  ['true', '1', 'yes'].includes(
    String(process.env.AIRPLANES_LIVE_ENABLED || '')
      .trim()
      .toLowerCase(),
  );

/**
 * A failing upstream never stalls the proxy on its error body: a non-2xx
 * response has its body cancelled at once and is handed on bodiless, so a
 * slow 5xx/429 body cannot delay serving usable data.
 */
async function failFastFetch(url, init) {
  const response = await globalThis.fetch(url, init);
  if (!response || response.ok) return response;
  try {
    response.body?.cancel?.().catch?.(() => {});
  } catch {
    /* ignore */
  }
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Splice `provider` into a JSON object body without re-serialising it. */
function withProvider(body, provider) {
  const text = String(body ?? '');
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open || text.trim()[0] !== '{')
    return text;
  const inner = text.slice(open + 1, close).trim();
  const encoded = `"provider":${JSON.stringify(provider)}`;
  return `${text.slice(0, close)}${inner ? ',' : ''}${encoded}${text.slice(close)}`;
}

/** Optional scene filter from `?lat=&lon=&radiusNm=[&point=1]`; null unless all three are usable. */
export function militarySceneFilter(searchParams) {
  const lat = queryNumber(searchParams, 'lat');
  const lon = queryNumber(searchParams, 'lon');
  const radiusNm = queryNumber(searchParams, 'radiusNm');
  if (lat == null || lon == null || radiusNm == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || radiusNm <= 0) return null;
  return {
    lat,
    lon,
    radiusNm: Math.min(FILTER_MAX_RADIUS_NM, radiusNm),
    point: searchParams.get('point') === '1',
  };
}

/** Rows within the scene radius; rows lacking a position are dropped. */
export function filterMilitaryRows(rows, scene) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      distanceNm(scene.lat, scene.lon, lat, lon) <= scene.radiusNm
    );
  });
}

const isMilitaryRow = (row) => (Number(row?.dbFlags) & 1) === 1;

/**
 * Vite plugin: adsb.lol military aircraft proxy — 12 s response cache,
 * last-good memory, alternative feeds and an optional scene filter.
 *
 * GET /api/adsblol/mil[?lat=&lon=&radiusNm=[&point=1]]
 *
 * Resolution order (every answer that carries data is HTTP 200 with
 * X-Provider-Status / body.provider — server/providers/common/upstream.js):
 *   fresh adsb.lol /v2/mil (≤ 12 s) .............. live      (X-ADS-B-Cache HIT|MISS)
 *   adsb.fi /api/v2/mil (≤ 1 req/s) ............... degraded  (X-Provider-Source adsb.fi,
 *                                                              provider.error names the adsb.lol reason)
 *   airplanes.live /v2/mil (AIRPLANES_LIVE_ENABLED) degraded
 *   newest last-good of any feed (≤ 30 min) ....... stale     (X-ADS-B-Cache STALE + age)
 *   nothing at all ................................ HTTP 503  { error, provider: { status: 'unavailable' } }
 * A failing feed earns a bounded cooldown (Retry-After when sane, 5 s … 120 s;
 * 30 s for a bare 429, 15 s otherwise) so a rate limit is never hammered
 * mid-cooldown. The proxy never relays a raw upstream status and never
 * answers 502 — the browser layer treated a relayed 429 as a 45 s cooldown
 * during which every refresh reported "adsb.lol rate limited" and the global
 * status chip read LOAD FAILED while the map was still fully populated.
 *
 * Scene filter: when `lat`, `lon` and `radiusNm` are all finite the rows are
 * filtered server-side by great-circle distance (rows without a position are
 * dropped), `X-Flight-Coverage: <r>nm around <lat>,<lon>` is added and
 * provider.count is the filtered count; one cached upstream list serves every
 * client. `point=1` uses adsb.lol /v2/point/{lat}/{lon}/{r≤250} filtered to
 * military (`dbFlags & 1`) as the primary instead.
 *
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy() {
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  /** A last-good list older than this is no longer served, even as STALE. */
  const LAST_GOOD_MAX_MS = 30 * 60_000;
  /** Cooldown after a 429 when upstream sends no usable Retry-After (ms). */
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  /** Cooldown after a 5xx / timeout / network error (ms). */
  const SERVER_ERROR_COOLDOWN_MS = 15000;
  /** Cooldown after a 401/403 (airplanes.live without approval) (ms). */
  const AUTH_COOLDOWN_MS = 5 * 60_000;
  /** Bounds for an upstream-supplied Retry-After (ms). */
  const COOLDOWN_MIN_MS = 5000;
  const COOLDOWN_MAX_MS = 120000;
  /** Last-good lists per feed ('adsb.lol' | 'adsb.fi' | 'airplanes.live') and per point key. */
  const lastGood = createLastGoodStore({ maxEntries: 24 });
  /** Per-feed single-flight map. */
  const inFlight = new Map();
  /** @type {Map<string, {until:number, failure:object}>} Per-feed cooldowns. */
  const cooldowns = new Map();
  const LIST_FEEDS = ['adsb.lol', 'adsb.fi', 'airplanes.live'];

  const clampCooldown = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

  /** Classify a failed fetchUpstream result and start that feed's cooldown. */
  function fail(source, result, now, reasonOverride = null) {
    const code = result?.error?.code || 'network';
    const status = result?.status || 0;
    const retryAfterMs = Number(result?.retryAfterMs);
    const hasRetryAfter = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
    let cooldownMs;
    let reason;
    if (code === 'rate_limited') {
      cooldownMs = hasRetryAfter
        ? clampCooldown(retryAfterMs)
        : RATE_LIMIT_COOLDOWN_MS;
      reason = `${source} rate limited (retry in ${Math.round(cooldownMs / 1000)}s)`;
    } else if (code === 'upstream_5xx') {
      cooldownMs = hasRetryAfter
        ? clampCooldown(retryAfterMs)
        : SERVER_ERROR_COOLDOWN_MS;
      reason = `${source} HTTP ${status}`;
    } else if (code === 'timeout' || code === 'network') {
      cooldownMs = SERVER_ERROR_COOLDOWN_MS;
      reason = `${source} unreachable (${code === 'timeout' ? 'timeout' : 'network error'})`;
    } else if (code === 'auth') {
      cooldownMs = AUTH_COOLDOWN_MS;
      reason = `${source} HTTP ${status} (access not approved)`;
    } else {
      cooldownMs = SERVER_ERROR_COOLDOWN_MS;
      reason = status
        ? `${source} HTTP ${status}`
        : result?.error?.message || `${source} request failed`;
    }
    if (reasonOverride) reason = reasonOverride;
    const failure = { source, code, status, reason, cooldownMs };
    cooldowns.set(source, { until: now + cooldownMs, failure });
    console.warn(
      `[adsb.lol Proxy] ${reason}; cooling down ${Math.round(cooldownMs / 1000)} s`,
    );
    return {
      ok: false,
      failure: { ...failure, retryAfterSec: cooldownMs / 1000 },
    };
  }

  /** Whether a feed is cooling down; returns its failure with the remaining wait. */
  function cooling(source, now) {
    const entry = cooldowns.get(source);
    if (!entry || now >= entry.until) return null;
    return {
      ok: false,
      failure: {
        ...entry.failure,
        retryAfterSec: (entry.until - now) / 1000,
        cooling: true,
      },
    };
  }

  /**
   * One coalesced fetch of a readsb list. Resolves to { ok:true, entry } or
   * { ok:false, failure:{ source, code, status, reason, retryAfterSec } }.
   */
  async function fetchList(
    source,
    url,
    { key = source, throttle = null, transform = null } = {},
  ) {
    const fresh = lastGood.get(key);
    if (fresh && Date.now() - fresh.fetchedAt < CACHE_MS)
      return { ok: true, entry: fresh, cacheStatus: 'HIT' };
    const cool = cooling(source, Date.now());
    if (cool) return cool;
    const request = coalesceProxyRequest(inFlight, key, async () => {
      if (throttle && !(await throttle())) {
        return {
          ok: false,
          failure: {
            source,
            code: 'throttled',
            status: 0,
            reason: `${source} request queue is full`,
            retryAfterSec: ADSBFI_MAX_WAIT_MS / 1000,
          },
        };
      }
      const result = await fetchUpstream(url, {
        accept: 'application/json',
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        retries: 1,
        maxBytes: MAX_RESPONSE_BYTES,
        label: source,
        fetchImpl: failFastFetch,
      });
      const now = Date.now();
      if (!result.ok) return fail(source, result, now);
      let json = null;
      try {
        json = JSON.parse(result.text);
      } catch {
        json = null;
      }
      if (!json || typeof json !== 'object' || !Array.isArray(json.ac)) {
        return fail(
          source,
          { error: { code: 'malformed' }, status: result.status },
          now,
          `${source} returned malformed JSON`,
        );
      }
      if (transform) json = transform(json);
      const value = {
        text: transform ? JSON.stringify(json) : result.text,
        json,
        source,
      };
      const entry = lastGood.set(key, value, { fetchedAt: now, source });
      cooldowns.delete(source);
      return { ok: true, entry, cacheStatus: 'MISS' };
    });
    return request.promise;
  }

  /** The newest last-good list from any feed, or null. */
  function newestLastGood(keys, now) {
    let best = null;
    for (const key of keys) {
      const entry = lastGood.get(key);
      if (!entry || now - entry.fetchedAt > LAST_GOOD_MAX_MS) continue;
      if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
    }
    return best;
  }

  /** Serve a stored list (optionally scene-filtered) with the provider status. */
  function serveEntry(
    res,
    entry,
    { status, cacheStatus, scene, now, error = null, extra = {} },
  ) {
    const { text, json, source } = entry.value;
    const rows = scene ? filterMilitaryRows(json.ac, scene) : json.ac;
    const provider = providerStatus({
      status,
      source,
      fetchedAt: entry.fetchedAt,
      error,
      count: rows.length,
      now,
    });
    const body = scene
      ? JSON.stringify({ ...json, ac: rows, provider })
      : withProvider(text, provider);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-ADS-B-Cache': cacheStatus,
      ...(['HIT', 'STALE'].includes(cacheStatus)
        ? {
            'X-ADS-B-Cache-Age-Ms': String(Math.max(0, now - entry.fetchedAt)),
          }
        : {}),
      ...statusHeaders(provider),
      ...(scene
        ? {
            'X-Flight-Coverage': `${scene.radiusNm}nm around ${scene.lat},${scene.lon}`,
          }
        : {}),
      ...extra,
    });
    res.end(body);
  }

  /** Nothing at all could answer: HTTP 503 with the structured reason (never 502). */
  function serveUnavailable(res, failure, now) {
    const provider = providerStatus({
      status: 'unavailable',
      source: 'adsb.lol',
      error: failure.reason,
      now,
    });
    const retryAfterSec = Math.ceil(failure.retryAfterSec || 0);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'X-ADS-B-Cache': 'NONE',
      ...statusHeaders(provider),
      ...(failure.status
        ? { 'X-ADS-B-Upstream-Status': String(failure.status) }
        : {}),
      ...(retryAfterSec > 0 ? { 'Retry-After': String(retryAfterSec) } : {}),
    });
    res.end(JSON.stringify({ error: failure.reason, provider }));
  }

  async function handle(req, res) {
    const incoming = new URL(req.url || '', 'http://localhost');
    const scene = militarySceneFilter(incoming.searchParams);
    let now = Date.now();

    // Alternative primary: adsb.lol point query filtered to military rows.
    let pointFailure = null;
    if (scene?.point) {
      const nm = Math.min(
        POINT_MAX_RADIUS_NM,
        Math.max(1, Math.round(scene.radiusNm)),
      );
      const lat = Math.round(scene.lat * 4) / 4;
      const lon = Math.round(scene.lon * 4) / 4;
      const key = `point:${lat},${lon}:${nm}`;
      const point = await fetchList('adsb.lol', adsbLolPointUrl(lat, lon, nm), {
        key,
        transform: (json) => ({ ...json, ac: json.ac.filter(isMilitaryRow) }),
      });
      now = Date.now();
      if (point.ok) {
        serveEntry(res, point.entry, {
          status: 'live',
          cacheStatus: point.cacheStatus,
          scene,
          now,
        });
        return;
      }
      pointFailure = point.failure;
    }

    // Primary: the full military list (one cached call serves every client).
    const primary = await fetchList('adsb.lol', ADSBLOL_MIL_URL);
    now = Date.now();
    if (primary.ok) {
      serveEntry(res, primary.entry, {
        status: 'live',
        cacheStatus: primary.cacheStatus,
        scene,
        now,
      });
      return;
    }
    // The list failure is the one the fallbacks explain; a failed point query
    // (same host) only ever precedes it.
    const failure = primary.failure || pointFailure;
    const upstreamStatus = failure.status
      ? { 'X-ADS-B-Upstream-Status': String(failure.status) }
      : {};

    // Fallback feeds: adsb.fi, then airplanes.live when the operator opted in.
    const fallbacks = [
      ['adsb.fi', ADSBFI_MIL_URL, { throttle: adsbFiSlot }],
      ...(airplanesLiveEnabled()
        ? [['airplanes.live', AIRPLANES_LIVE_MIL_URL, {}]]
        : []),
    ];
    for (const [source, url, options] of fallbacks) {
      const outcome = await fetchList(source, url, options);
      now = Date.now();
      if (outcome.ok) {
        serveEntry(res, outcome.entry, {
          status: 'degraded',
          cacheStatus: outcome.cacheStatus,
          scene,
          now,
          error: `${failure.reason} - ${source} feed`,
          extra: upstreamStatus,
        });
        return;
      }
    }

    // Last-good from any feed beats an error for up to 30 min.
    const stale = newestLastGood(LIST_FEEDS, now);
    if (stale) {
      serveEntry(res, stale, {
        status: 'stale',
        cacheStatus: 'STALE',
        scene,
        now,
        error: `${failure.reason} - last-good ${stale.value.source} list`,
        extra: {
          ...upstreamStatus,
          'X-ADS-B-Retry-After-Seconds': String(
            Math.ceil(failure.retryAfterSec || 0),
          ),
        },
      });
      return;
    }
    serveUnavailable(res, failure, now);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsblol/mil', async (req, res) => {
      try {
        await handle(req, res);
      } catch (e) {
        console.error('[adsb.lol Proxy]', e?.message || e);
        if (res.headersSent || res.writableEnded) return;
        const now = Date.now();
        const stale = newestLastGood(LIST_FEEDS, now);
        const reason = `adsb.lol proxy error (${String(e?.message || e).slice(0, 120)})`;
        if (stale) {
          serveEntry(res, stale, {
            status: 'stale',
            cacheStatus: 'STALE',
            scene: null,
            now,
            error: `${reason} - last-good ${stale.value.source} list`,
          });
          return;
        }
        serveUnavailable(res, { reason, status: 0, retryAfterSec: 15 }, now);
      }
    });
  };
  return {
    name: 'adsblol-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
