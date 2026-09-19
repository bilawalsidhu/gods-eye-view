import { normalizeAdsbLolPointResponse } from '../../../src/data/adsbLolFallback.js';
import { coalesceProxyRequest } from '../common/http.js';
import { requiredFiniteQueryNumber } from '../common/query.js';
import {
  bboxAround,
  createLastGoodStore,
  fetchUpstream,
  providerStatus,
  statusHeaders,
} from '../common/upstream.js';
// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
let _openskyToken = null;
/** @type {number} Epoch-ms when the current token expires. */
let _openskyTokenExpiry = 0;
/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
let _openskyTokenPromise = null;
/** @type {number} Epoch-ms before which the token endpoint is not contacted again (unreachable / rejected). */
let _openskyTokenUnavailableUntil = 0;
/** @type {string|null} Human reason for the last OAuth failure (surfaces as provider.error). */
let _openskyAuthFailure = null;
/** How long a failed token request keeps the token endpoint out of the request path (ms). */
const OPENSKY_TOKEN_RETRY_MS = 60_000;
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Last-good OpenSky snapshots per scene (0.25°-rounded anchor key; 'world'
 * when the client sent no anchor). Serverless fix 2026-09-18: the proxy used
 * to fetch the WHOLE WORLD (`/states/all`, ~8 MB, 4 credits) for every
 * viewer; it now asks for a scene bounding box (OPENSKY_BBOX_DEGREES each
 * side, default 1.5° → a 3°×3° box costs 1 anonymous credit) so every client
 * inside the same 0.25° cell shares one upstream call.
 */
const _openskyStore = createLastGoodStore({ maxEntries: 16 });
/** Per-scene single-flight map for concurrent OpenSky requests. */
const _openskyInFlight = new Map();
/** TTL for the OpenSky response cache (ms). */
const OPENSKY_CACHE_MS = 9000;
/** A last-good snapshot older than this is no longer served, even as STALE. */
const OPENSKY_LAST_GOOD_MAX_MS = 30 * 60_000;
// --- OpenSky credit governor (field-test fix 2026-07-06) -------------------
// The global /states/all this proxy fetches costs 4 CREDITS per call against
// OpenSky's ~4000/day authenticated budget — a day with the app open burned
// the whole quota in ~8h and the layer then hard-died until the daily reset
// ("rate limited for 48h" owner report; auth itself was fine). Three levers:
//  1. Adaptive TTL: OpenSky returns X-Rate-Limit-Remaining on success; as the
//     budget thins, the proxy stretches its cache TTL so a full day of
//     continuous use never exhausts it.
//  2. 429 cooldown: honor X-Rate-Limit-Retry-After-Seconds — no upstream
//     attempts until it passes (bounded 30 s … 30 min).
//  3. Serve-stale: while rate-limited/cooling, serve the last-good body (200 +
//     X-OpenSky-Stale) so the layer keeps rendering instead of dying.
/** @type {number} Current adaptive TTL (ms) — starts at the base cache TTL. */
let _openskyTtlMs = OPENSKY_CACHE_MS;
/** @type {number} Epoch-ms before which no upstream fetch is attempted. */
let _openskyCooldownUntil = 0;
/** @type {'rate_limited'|'upstream_5xx'|null} What started the current cooldown. */
let _openskyCooldownKind = null;
/** @type {number} Upstream HTTP status that started the current cooldown. */
let _openskyCooldownStatus = 0;
/** Cooldown after an OpenSky 5xx (ms). */
const OPENSKY_SERVER_ERROR_COOLDOWN_MS = 30_000;
// --- Circuit breaker (serverless fix 2026-09-18) ----------------------------
// From cloud egress (Vercel, region IAD measured) opensky-network.org
// black-holes the TCP connect: every attempt ends in UND_ERR_CONNECT_TIMEOUT
// after ~10 s, both the bbox and the worldwide form. Waiting that out on every
// 30 s poll made the DATA LAYERS row read "OpenSky HTTP 502 · retry 20s". On
// a connect timeout / network error the proxy now opens this breaker for
// OPENSKY_BREAKER_MS (default 10 min): OpenSky is skipped entirely and the
// regional feeds answer immediately.
/** @type {number} Epoch-ms until which OpenSky is bypassed. */
let _openskyUnreachableUntil = 0;
/** @type {string|null} Human reason the breaker is open. */
let _openskyUnreachableReason = null;
/** @type {boolean} Log the breaker opening once per outage, not per poll. */
let _openskyBreakerWarned = false;

/** Finite, bounded numeric env override; `fallback` when unset/invalid. */
function envNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
const openskyTimeoutMs = () =>
  envNumber('OPENSKY_TIMEOUT_MS', 6000, 1000, 30_000);
const openskyBreakerMs = () =>
  envNumber('OPENSKY_BREAKER_MS', 10 * 60_000, 10_000, 6 * 3_600_000);
/** Extra attempts per states call (default 0 — see fetchOpenSkyStates). */
const openskyRetries = () => Math.round(envNumber('OPENSKY_RETRIES', 0, 0, 2));
const openskyBboxDegrees = () =>
  envNumber('OPENSKY_BBOX_DEGREES', 1.5, 0.05, 10);
const fallbackRadiusNm = () =>
  Math.round(envNumber('OPENSKY_FALLBACK_RADIUS_NM', 250, 10, 250));
const airplanesLiveEnabled = () =>
  ['true', '1', 'yes'].includes(
    String(process.env.AIRPLANES_LIVE_ENABLED || '')
      .trim()
      .toLowerCase(),
  );

/**
 * Failing upstreams never get to stall the proxy on their error body: a
 * non-2xx response has its body cancelled immediately and is handed on
 * bodiless, so a slow 5xx/429 body cannot delay the fallback chain (the
 * shared helper would otherwise drain it before deciding).
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
/**
 * Picks the cache TTL from the remaining daily credit budget.
 * Client polls every 30 s, so tiers ≤30 s cost the same 480 credits/h; the
 * later tiers stretch the day: >2400 → ~3 h of full freshness, then 30 s
 * (~2.5 h), 90 s (~5 h), 300 s (~8 h) ≈ 18+ h of continuous use per day.
 * @param {number} remaining - X-Rate-Limit-Remaining header value.
 * @returns {number} TTL in ms.
 */
function openskyAdaptiveTtlMs(remaining) {
  if (!Number.isFinite(remaining)) return OPENSKY_CACHE_MS;
  if (remaining > 2400) return OPENSKY_CACHE_MS;
  if (remaining > 1200) return 30_000;
  if (remaining > 400) return 90_000;
  return 300_000;
}
/** @type {boolean} Guards duplicate auth-failure warnings in logs. */
let _openskyAuthWarned = false;
/** @type {boolean} Guards duplicate invalid-auth-mode warnings. */
let _openskyAuthModeWarned = false;
/** Default auth mode when OPENSKY_AUTH_MODE env is unset. */
const OPENSKY_AUTH_MODE_DEFAULT = 'oauth';
/** Set of valid OPENSKY_AUTH_MODE values. */
const OPENSKY_AUTH_MODE_SET = new Set(['basic', 'oauth', 'auto', 'anon']);
// --- Regional fallback feeds (readsb aggregators) ---------------------------
// When OpenSky cannot answer, a bounded point query around the client's view
// anchor stands in: adsb.lol first, then adsb.fi (≤ 1 request/s per endpoint,
// module-scoped throttle), then airplanes.live ONLY when the operator opted
// in (AIRPLANES_LIVE_ENABLED=true — the public API answers 403 without prior
// approval). Each feed keeps a 30 s last-good per 0.25° point so every client
// in the same cell shares one call; a failing feed is skipped for a short
// cooldown instead of being retried on every poll.
const REGIONAL_FEEDS = Object.freeze([
  {
    source: 'adsb.lol',
    usedMode: 'adsblol-regional',
    url: (lat, lon, nm) =>
      `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    enabled: () => true,
  },
  {
    source: 'adsb.fi',
    usedMode: 'adsbfi-regional',
    url: (lat, lon, nm) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    enabled: () => true,
    throttle: () => adsbFiSlot(),
  },
  {
    source: 'airplanes.live',
    usedMode: 'airplaneslive-regional',
    url: (lat, lon, nm) =>
      `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
    enabled: airplanesLiveEnabled,
  },
]);
/** Last-good regional snapshots keyed `${source}:${pointKey}`. */
const _regionalStore = createLastGoodStore({ maxEntries: 80 });
/** Per-key single-flight map for concurrent regional fallback requests. */
const _regionalInFlight = new Map();
/** @type {Map<string, number>} Epoch-ms until which a failing regional feed is skipped. */
const _regionalFailUntil = new Map();
const REGIONAL_FRESH_MS = 30_000;
const REGIONAL_LAST_GOOD_MAX_MS = 30 * 60_000;
const REGIONAL_FAIL_COOLDOWN_MS = 30_000;
const REGIONAL_TIMEOUT_MS = 10_000;
const REGIONAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** adsb.fi asks for at most one request per second per endpoint. */
const ADSBFI_MIN_INTERVAL_MS = 1000;
const ADSBFI_MAX_WAIT_MS = 3000;
/** @type {number} Epoch-ms of the next free adsb.fi request slot. */
let _adsbFiNextSlot = 0;
// A 200 response can still contain an old OpenSky snapshot. Past this point
// the viewport-scoped regional source is more honest and keeps local motion
// current instead of coasting a stale frame indefinitely.
const OPENSKY_SOURCE_STALE_MS = 120_000;

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

/**
 * Obtain a valid OpenSky OAuth2 bearer token, refreshing if needed.
 *
 * Uses the client_credentials grant against the OpenSky Keycloak realm.
 * Concurrent callers share a single in-flight refresh promise so only
 * one token request is issued at a time.
 *
 * @returns {Promise<string|null>} Bearer token string, or null if unavailable.
 */
export async function getOpenSkyToken() {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_openskyToken && now < _openskyTokenExpiry - 60000) return _openskyToken;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_openskyTokenPromise) return _openskyTokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  // A token endpoint that just timed out or rejected the credentials is not
  // asked again on every poll — the states request proceeds anonymously.
  if (now < _openskyTokenUnavailableUntil) return null;

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  _openskyTokenPromise = (async () => {
    try {
      const result = await fetchUpstream(OPENSKY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        accept: 'application/json',
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        timeoutMs: 6000,
        retries: 1,
        maxBytes: 64 * 1024,
        label: 'OpenSky OAuth',
        fetchImpl: failFastFetch,
      });

      let data = null;
      if (result.ok) {
        try {
          data = JSON.parse(result.text);
        } catch {
          data = null;
        }
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!result.ok || !accessToken) {
        const code = result.error?.code || 'malformed';
        const detail = result.ok
          ? 'token response carried no access_token'
          : result.error?.message || `HTTP ${result.status}`;
        if (!_openskyAuthWarned) {
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
        const unreachable = code === 'timeout' || code === 'network';
        // An unreachable token endpoint sits on the same black-holed network
        // as the states API: keep it out of the request path for a whole
        // breaker window so the first re-probe is a single anonymous call
        // instead of two back-to-back connect timeouts.
        _openskyTokenUnavailableUntil =
          Date.now() +
          OPENSKY_TOKEN_RETRY_MS +
          (unreachable ? openskyBreakerMs() : 0);
        _openskyAuthFailure = unreachable
          ? 'OpenSky OAuth endpoint unreachable from this deployment'
          : code === 'auth' || result.status === 400
            ? 'OpenSky OAuth rejected credentials'
            : `OpenSky OAuth failed (${detail})`;
        return null;
      }

      _openskyToken = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _openskyTokenExpiry =
        Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      console.log(
        '[OpenSky] OAuth token refreshed, expires in',
        Number.isFinite(expiresIn) ? expiresIn : 1800,
        's',
      );
      _openskyAuthWarned = false;
      _openskyAuthFailure = null;
      _openskyTokenUnavailableUntil = 0;
      return _openskyToken;
    } catch (err) {
      if (!_openskyAuthWarned) {
        console.warn(
          '[OpenSky] OAuth token request failed:',
          err?.message || String(err),
        );
        _openskyAuthWarned = true;
      }
      _openskyToken = null;
      _openskyTokenExpiry = 0;
      _openskyTokenUnavailableUntil = Date.now() + OPENSKY_TOKEN_RETRY_MS;
      _openskyAuthFailure = `OpenSky OAuth failed (${err?.message || err})`;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _openskyTokenPromise = null;
    }
  })();

  return _openskyTokenPromise;
}

/**
 * Validate and normalize the OPENSKY_AUTH_MODE env value.
 *
 * @param {string} value - Raw env value (e.g. 'basic', 'oauth', 'auto', 'anon').
 * @returns {string} One of the valid mode strings, or the default ('oauth').
 */
function normalizeOpenSkyAuthMode(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return OPENSKY_AUTH_MODE_DEFAULT;
  if (OPENSKY_AUTH_MODE_SET.has(raw)) return raw;
  if (!_openskyAuthModeWarned) {
    console.warn(
      `[OpenSky] Invalid OPENSKY_AUTH_MODE="${raw}", defaulting to "${OPENSKY_AUTH_MODE_DEFAULT}"`,
    );
    _openskyAuthModeWarned = true;
  }
  return OPENSKY_AUTH_MODE_DEFAULT;
}

/**
 * Build standard response headers for OpenSky proxy responses.
 *
 * Includes diagnostic X-OpenSky-* headers so the client can inspect
 * cache hit/miss status and which auth mode was actually used.
 *
 * @param {object} opts
 * @param {string} opts.cacheStatus - 'HIT', 'MISS', or 'STALE'.
 * @param {string} opts.requestedMode - The auth mode the config requested.
 * @param {string} opts.usedMode - The auth mode actually used for the upstream call.
 * @param {string} opts.reason - Human-readable reason string for diagnostics.
 * @returns {Record<string,string>} Header object.
 */
function buildOpenSkyHeaders({
  cacheStatus,
  requestedMode,
  usedMode,
  reason,
  staleSeconds,
  retryAfterSeconds,
}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-OpenSky-Cache': cacheStatus,
    'X-OpenSky-Auth': usedMode,
    'X-OpenSky-Auth-Mode-Requested': requestedMode,
    'X-OpenSky-Auth-Mode-Used': usedMode,
    'X-OpenSky-Auth-Reason': reason,
  };
  // Credit-governor extras (field-test fix 2026-07-06): the client can show a
  // STALE cue / countdown without parsing the body.
  if (Number.isFinite(staleSeconds))
    headers['X-OpenSky-Stale-Seconds'] = String(Math.round(staleSeconds));
  if (Number.isFinite(retryAfterSeconds))
    headers['X-OpenSky-Retry-After-Seconds'] = String(
      Math.round(retryAfterSeconds),
    );
  return headers;
}

export function adsbLolFallbackAnchor(req) {
  const incoming = new URL(req?.url || '', 'http://localhost');
  const latitude = requiredFiniteQueryNumber(incoming.searchParams, 'lat');
  const longitude = requiredFiniteQueryNumber(incoming.searchParams, 'lon');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    return null;
  return { latitude, longitude };
}

/**
 * The scene a request is about: the 0.25°-rounded anchor (shared cache key
 * for every client in the same cell), the OpenSky bounding box around it and
 * the coverage label the client shows. Null without a usable anchor.
 */
function sceneFor(anchor) {
  if (!anchor) return null;
  const lat = Math.round(anchor.latitude * 4) / 4;
  const lon = Math.round(anchor.longitude * 4) / 4;
  const degrees = openskyBboxDegrees();
  const bbox = bboxAround(lat, lon, degrees);
  if (!bbox) return null;
  return {
    key: `${lat.toFixed(2)},${lon.toFixed(2)}`,
    lat,
    lon,
    bbox,
    coverage: `${(2 * degrees).toFixed(1)}deg scene box around ${lat.toFixed(2)},${lon.toFixed(2)}`,
  };
}

/** The OpenSky states URL for a scene (bounding box) or the whole world. */
function openSkyStatesUrl(scene) {
  if (!scene) return `${OPENSKY_STATES_URL}?extended=1`;
  const { lamin, lomin, lamax, lomax } = scene.bbox;
  return `${OPENSKY_STATES_URL}?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}&extended=1`;
}

/**
 * Splice `provider` into a JSON object body without re-serialising it (the
 * cached worldwide frame is several MB). Non-object bodies pass through.
 */
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

/** Fetch one regional feed around a scene point; null when it cannot answer. */
async function fetchRegionalFeed(feed, scene) {
  if (!feed.enabled()) return null;
  const radiusNm = fallbackRadiusNm();
  const key = `${feed.source}:${scene.key}:${radiusNm}`;
  const cached = _regionalStore.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < REGIONAL_FRESH_MS) {
    return { ...cached.value, fetchedAt: cached.fetchedAt, cacheStatus: 'HIT' };
  }
  if (now < (_regionalFailUntil.get(feed.source) || 0)) return null;
  const request = coalesceProxyRequest(_regionalInFlight, key, async () => {
    if (feed.throttle && !(await feed.throttle()))
      throw new Error(`${feed.source} request queue is full`);
    const result = await fetchUpstream(
      feed.url(scene.lat, scene.lon, radiusNm),
      {
        accept: 'application/json',
        timeoutMs: REGIONAL_TIMEOUT_MS,
        retries: 1,
        maxBytes: REGIONAL_MAX_RESPONSE_BYTES,
        label: feed.source,
        fetchImpl: failFastFetch,
      },
    );
    if (!result.ok) {
      const error = new Error(
        result.error?.message || `${feed.source} request failed`,
      );
      error.retryAfterMs = result.retryAfterMs;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch {
      throw new Error(`${feed.source} returned malformed JSON`);
    }
    // adsb.lol / airplanes.live answer `{ ac, now }`; adsb.fi's lat/lon/dist
    // route answers `{ aircraft, now }` — same readsb rows either way.
    const normalized = normalizeAdsbLolPointResponse({
      now: payload?.now,
      ac: Array.isArray(payload?.ac) ? payload.ac : payload?.aircraft,
    });
    const value = {
      body: JSON.stringify(normalized),
      count: normalized.states.length,
      source: feed.source,
      usedMode: feed.usedMode,
    };
    const entry = _regionalStore.set(key, value, {
      fetchedAt: Date.now(),
      source: feed.source,
    });
    _regionalFailUntil.delete(feed.source);
    return { ...value, fetchedAt: entry.fetchedAt };
  });
  try {
    const record = await request.promise;
    return { ...record, cacheStatus: request.shared ? 'INFLIGHT' : 'MISS' };
  } catch (error) {
    if (!request.shared) {
      const retryAfterMs = Number(error?.retryAfterMs);
      _regionalFailUntil.set(
        feed.source,
        Date.now() +
          Math.min(
            REGIONAL_LAST_GOOD_MAX_MS,
            Math.max(
              REGIONAL_FAIL_COOLDOWN_MS,
              Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
            ),
          ),
      );
      console.warn(
        `[${feed.source} Flights Fallback]`,
        error?.message || error,
      );
    }
    return null;
  }
}

/** The freshest last-good regional snapshot for a scene, from any feed. */
function staleRegionalRecord(scene) {
  if (!scene) return null;
  const radiusNm = fallbackRadiusNm();
  const now = Date.now();
  let best = null;
  for (const feed of REGIONAL_FEEDS) {
    const cached = _regionalStore.get(
      `${feed.source}:${scene.key}:${radiusNm}`,
    );
    if (!cached || now - cached.fetchedAt > REGIONAL_LAST_GOOD_MAX_MS) continue;
    if (!best || cached.fetchedAt > best.fetchedAt)
      best = {
        ...cached.value,
        fetchedAt: cached.fetchedAt,
        cacheStatus: 'STALE',
      };
  }
  return best;
}

/**
 * Answer from a regional feed (adsb.lol → adsb.fi → airplanes.live when
 * opted in) as HTTP 200 `degraded`, naming why OpenSky was bypassed. False
 * when no feed could answer (or the request carried no anchor).
 */
async function serveRegionalFallback(
  res,
  { requestedMode, scene, reasonCode, reason, retryAfterSec, now },
) {
  if (!scene) return false;
  for (const feed of REGIONAL_FEEDS) {
    const record = await fetchRegionalFeed(feed, scene);
    if (record) {
      serveRegionalRecord(res, record, {
        requestedMode,
        reasonCode: `${reasonCode}_regional_fallback`,
        reason,
        retryAfterSec,
        now,
      });
      return true;
    }
  }
  return false;
}

function serveRegionalRecord(
  res,
  record,
  { requestedMode, reasonCode, reason, retryAfterSec, now },
) {
  const stale = record.cacheStatus === 'STALE';
  const provider = providerStatus({
    status: stale ? 'stale' : 'degraded',
    source: record.source,
    fetchedAt: record.fetchedAt,
    // ASCII only: X-Provider-Error cannot carry an em dash.
    error: `${reason} - ${record.source} regional feed${stale ? ' (last-good)' : ''}`,
    count: record.count,
    now,
  });
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus: record.cacheStatus,
      requestedMode,
      usedMode: record.usedMode,
      reason: reasonCode,
      staleSeconds: stale ? (now - record.fetchedAt) / 1000 : undefined,
      retryAfterSeconds: retryAfterSec,
    }),
    ...statusHeaders(provider),
    'X-Flight-Source': record.source,
    'X-Flight-Coverage': `${fallbackRadiusNm()}nm regional fallback`,
    'X-Flight-Count': String(record.count),
  });
  res.end(withProvider(record.body, provider));
}

/** Parse an OpenSky body once: source snapshot epoch and state count. */
function inspectOpenSkyBody(body) {
  try {
    const parsed = JSON.parse(body);
    const seconds = Number(parsed?.time);
    return {
      sourceEpochMs:
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      count: Array.isArray(parsed?.states) ? parsed.states.length : null,
      valid: parsed !== null && typeof parsed === 'object',
    };
  } catch {
    return { sourceEpochMs: null, count: null, valid: false };
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return (
    Number.isFinite(sourceEpochMs) &&
    now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS
  );
}

function snapshotAgeReason(sourceEpochMs, now) {
  return `OpenSky snapshot ${Math.max(2, Math.round((now - sourceEpochMs) / 60_000))} min old`;
}

/** A last-good OpenSky entry for a scene, or null when absent / too old. */
function lastGoodOpenSky(key, now) {
  const entry = _openskyStore.get(key);
  if (!entry || now - entry.fetchedAt > OPENSKY_LAST_GOOD_MAX_MS) return null;
  return entry;
}

/**
 * Why OpenSky is not contacted right now: the circuit breaker (connect
 * timeout / network error) or a 429 / 5xx cooldown. Null when it may be tried.
 */
function openSkyBypass(now) {
  if (now < _openskyUnreachableUntil) {
    const retryAfterSec = (_openskyUnreachableUntil - now) / 1000;
    return {
      reasonCode: 'opensky_unreachable',
      reason:
        _openskyUnreachableReason ||
        'OpenSky unreachable from this deployment (connect timeout)',
      retryAfterSec,
    };
  }
  if (now < _openskyCooldownUntil) {
    const retryAfterSec = (_openskyCooldownUntil - now) / 1000;
    if (_openskyCooldownKind === 'upstream_5xx') {
      return {
        reasonCode: `opensky_http_${_openskyCooldownStatus || 503}`,
        reason: `OpenSky HTTP ${_openskyCooldownStatus || 503} (retry in ${Math.ceil(retryAfterSec)}s)`,
        retryAfterSec,
      };
    }
    return {
      reasonCode: 'rate_limited',
      reason: `OpenSky rate limited (retry in ${Math.ceil(retryAfterSec)}s)`,
      retryAfterSec,
    };
  }
  return null;
}

/** Resolve the Authorization header for the requested auth mode. */
async function resolveOpenSkyAuth(requestedMode) {
  const basicUser = process.env.OPENSKY_USERNAME || '';
  const basicPass = process.env.OPENSKY_PASSWORD || '';
  const hasBasicCreds = Boolean(basicUser && basicPass);
  const basicHeader = hasBasicCreds
    ? `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`
    : null;
  const headers = {};
  let usedMode = 'anon';
  let reason = 'forced_anonymous';
  if (requestedMode === 'basic') {
    if (basicHeader) {
      headers.Authorization = basicHeader;
      usedMode = 'basic';
      reason = 'basic_credentials';
    } else {
      reason = 'missing_basic_creds';
    }
  } else if (requestedMode === 'oauth') {
    const token = await getOpenSkyToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      usedMode = 'oauth';
      reason = 'oauth_token';
    } else {
      reason = 'oauth_invalid_or_missing';
    }
  } else if (requestedMode === 'auto') {
    const token = await getOpenSkyToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      usedMode = 'oauth';
      reason = 'oauth_token';
    } else if (basicHeader) {
      headers.Authorization = basicHeader;
      usedMode = 'basic';
      reason = 'oauth_unavailable_fallback_basic';
    } else {
      reason = 'missing_oauth_and_basic_creds';
    }
  }
  return { headers, usedMode, reason, hasBasicCreds, basicHeader };
}

/** Machine reason code + human text for an OpenSky 401/403. */
function authFailure({ requestedMode, usedMode, hasBasicCreds }) {
  if (requestedMode === 'basic' && !hasBasicCreds)
    return {
      reasonCode: 'missing_basic_creds',
      reason:
        'OpenSky auth missing (basic mode requires OPENSKY_USERNAME and OPENSKY_PASSWORD)',
    };
  if (requestedMode === 'oauth' && usedMode !== 'oauth')
    return {
      reasonCode: 'oauth_invalid_or_missing',
      reason:
        _openskyAuthFailure ||
        'OpenSky auth required (set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET)',
    };
  if (usedMode === 'basic')
    return {
      reasonCode: 'basic_invalid_credentials',
      reason: 'OpenSky username/password rejected',
    };
  if (usedMode === 'oauth')
    return {
      reasonCode: 'oauth_invalid_credentials',
      reason: 'OpenSky OAuth rejected credentials',
    };
  if (requestedMode === 'auto' && !hasBasicCreds)
    return {
      reasonCode: 'missing_oauth_and_basic_creds',
      reason:
        'OpenSky auth required (provide OAuth client credentials or a username/password)',
    };
  return { reasonCode: 'auth_required', reason: 'OpenSky auth required' };
}

/**
 * Classify a failed OpenSky states call, updating the breaker / cooldown
 * state it implies. Returns { reasonCode, reason, retryAfterSec, status }.
 */
function classifyOpenSkyFailure(
  result,
  { requestedMode, usedMode, hasBasicCreds, now },
) {
  const code = result.error?.code;
  if (code === 'timeout' || code === 'network') {
    const breakerMs = openskyBreakerMs();
    const reason = `OpenSky unreachable from this deployment (${code === 'timeout' ? 'connect timeout' : 'network error'})`;
    _openskyUnreachableUntil = now + breakerMs;
    _openskyUnreachableReason = reason;
    if (!_openskyBreakerWarned) {
      console.warn(
        `[OpenSky] ${reason}; bypassing OpenSky for ${Math.round(breakerMs / 60_000)} min — ${result.error?.message || code}`,
      );
      _openskyBreakerWarned = true;
    }
    return {
      reasonCode: 'opensky_unreachable',
      reason,
      retryAfterSec: breakerMs / 1000,
      status: 0,
    };
  }
  if (code === 'rate_limited') {
    // Credit governor: honor OpenSky's retry-after (bounded 30 s … 30 min;
    // 2 min when the header is absent) — no upstream attempts until then.
    const retryAfterMs = Number(result.retryAfterMs);
    const cooldownMs = Math.min(
      Math.max(Number.isFinite(retryAfterMs) ? retryAfterMs : 120_000, 30_000),
      30 * 60_000,
    );
    _openskyCooldownUntil = now + cooldownMs;
    _openskyCooldownKind = 'rate_limited';
    _openskyCooldownStatus = 429;
    return {
      reasonCode: 'rate_limited',
      reason: `OpenSky rate limited (retry in ${Math.round(cooldownMs / 1000)}s)`,
      retryAfterSec: cooldownMs / 1000,
      status: 429,
    };
  }
  if (code === 'auth') {
    return {
      ...authFailure({ requestedMode, usedMode, hasBasicCreds }),
      retryAfterSec: null,
      status: result.status,
    };
  }
  if (code === 'upstream_5xx') {
    _openskyCooldownUntil = now + OPENSKY_SERVER_ERROR_COOLDOWN_MS;
    _openskyCooldownKind = 'upstream_5xx';
    _openskyCooldownStatus = result.status;
    return {
      reasonCode: `opensky_http_${result.status}`,
      reason: `OpenSky HTTP ${result.status}`,
      retryAfterSec: OPENSKY_SERVER_ERROR_COOLDOWN_MS / 1000,
      status: result.status,
    };
  }
  if (code === 'too_large') {
    return {
      reasonCode: 'opensky_response_too_large',
      reason: 'OpenSky response too large',
      retryAfterSec: null,
      status: result.status,
    };
  }
  return {
    reasonCode: result.status
      ? `opensky_http_${result.status}`
      : 'opensky_request_failed',
    reason: result.status
      ? `OpenSky HTTP ${result.status}`
      : result.error?.message || 'OpenSky request failed',
    retryAfterSec: null,
    status: result.status || 0,
  };
}

/**
 * One coalesced OpenSky states fetch for a scene. Resolves to
 * { ok:true, entry } (stored last-good) or { ok:false, failure }.
 */
async function fetchOpenSkyStates({ scene, requestedMode }) {
  const key = scene ? scene.key : 'world';
  const request = coalesceProxyRequest(_openskyInFlight, key, async () => {
    const auth = await resolveOpenSkyAuth(requestedMode);
    const url = openSkyStatesUrl(scene);
    const options = {
      accept: 'application/json',
      timeoutMs: openskyTimeoutMs(),
      // OPENSKY_RETRIES (default 0): opensky-network.org black-holes cloud
      // egress with a CONNECT timeout, which a 250 ms jittered retry cannot
      // fix — one probe per breaker window keeps the first paint under ~6 s.
      retries: openskyRetries(),
      maxBytes: OPENSKY_MAX_RESPONSE_BYTES,
      label: 'OpenSky',
      fetchImpl: failFastFetch,
    };
    let { usedMode, reason } = auth;
    let result = await fetchUpstream(url, {
      ...options,
      headers: auth.headers,
    });
    // Auto-mode fallback: if OAuth was rejected, retry with Basic credentials
    if (
      !result.ok &&
      result.error?.code === 'auth' &&
      requestedMode === 'auto' &&
      usedMode === 'oauth' &&
      auth.basicHeader
    ) {
      result = await fetchUpstream(url, {
        ...options,
        headers: { Authorization: auth.basicHeader },
      });
      usedMode = 'basic';
      reason = 'oauth_rejected_fallback_basic';
    }
    const now = Date.now();
    if (result.ok) {
      const inspected = inspectOpenSkyBody(result.text);
      if (!inspected.valid) {
        return {
          ok: false,
          failure: {
            reasonCode: 'opensky_malformed',
            reason: 'OpenSky returned malformed JSON',
            retryAfterSec: null,
            status: result.status,
          },
        };
      }
      // Refine the reason string to reflect the actual outcome
      if (reason === 'forced_anonymous') reason = 'anonymous_ok';
      else if (usedMode === 'basic' && reason === 'basic_credentials')
        reason = 'basic_ok';
      else if (usedMode === 'oauth' && reason === 'oauth_token')
        reason = 'oauth_ok';
      const entry = _openskyStore.set(
        key,
        {
          body: result.text,
          sourceEpochMs: inspected.sourceEpochMs,
          count: inspected.count,
          meta: { requestedMode, usedMode, reason },
        },
        { fetchedAt: now, source: 'OpenSky Network' },
      );
      // Credit governor: adapt the cache TTL to the remaining daily budget so
      // a continuously-open app stretches its polls instead of exhausting the
      // quota mid-day. Success also clears any cooldown and the breaker.
      const remaining = Number(result.headers?.get?.('x-rate-limit-remaining'));
      _openskyTtlMs = openskyAdaptiveTtlMs(remaining);
      _openskyCooldownUntil = 0;
      _openskyCooldownKind = null;
      _openskyCooldownStatus = 0;
      _openskyUnreachableUntil = 0;
      _openskyUnreachableReason = null;
      _openskyBreakerWarned = false;
      return { ok: true, entry };
    }
    return {
      ok: false,
      failure: classifyOpenSkyFailure(result, {
        requestedMode,
        usedMode,
        hasBasicCreds: auth.hasBasicCreds,
        now,
      }),
    };
  });
  const outcome = await request.promise;
  return { ...outcome, shared: request.shared };
}

/** Serve a stored OpenSky snapshot as `live` (fresh) or `stale` (last-good). */
function serveOpenSkyEntry(
  res,
  entry,
  {
    cacheStatus,
    status,
    requestedMode,
    scene,
    now,
    reasonCode,
    reason,
    retryAfterSec,
  },
) {
  const { body, count, meta } = entry.value;
  const stale = status === 'stale';
  const provider = providerStatus({
    status,
    source: 'OpenSky Network',
    fetchedAt: entry.fetchedAt,
    error: stale ? `${reason} - last-good OpenSky snapshot` : null,
    count,
    now,
  });
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus,
      requestedMode: meta?.requestedMode || requestedMode,
      usedMode: meta?.usedMode || 'unknown',
      reason: stale
        ? reasonCode === 'rate_limited'
          ? 'rate_limited_serving_stale'
          : `${reasonCode}_serving_stale`
        : meta?.reason || 'cached',
      staleSeconds: stale ? (now - entry.fetchedAt) / 1000 : undefined,
      retryAfterSeconds: retryAfterSec ?? undefined,
    }),
    ...statusHeaders(provider),
    'X-Flight-Source': 'OpenSky Network',
    'X-Flight-Coverage': scene ? scene.coverage : 'worldwide upstream snapshot',
    ...(count == null ? {} : { 'X-Flight-Count': String(count) }),
  });
  res.end(withProvider(body, provider));
}

/** Nothing at all could answer: HTTP 503 with the structured reason (never 502). */
function serveOpenSkyUnavailable(
  res,
  { requestedMode, reasonCode, reason, retryAfterSec, now },
) {
  const provider = providerStatus({
    status: 'unavailable',
    source: 'OpenSky Network',
    error: reason,
    now,
  });
  res.writeHead(503, {
    ...buildOpenSkyHeaders({
      cacheStatus: 'MISS',
      requestedMode,
      usedMode: 'none',
      reason: reasonCode,
      retryAfterSeconds: retryAfterSec ?? undefined,
    }),
    ...statusHeaders(provider),
    // The fallbacks may recover long before OpenSky does — never ask the
    // client to stay away for the whole breaker window.
    ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? { 'Retry-After': String(Math.ceil(Math.min(retryAfterSec, 120))) }
      : {}),
  });
  res.end(JSON.stringify({ error: reason, provider }));
}

/**
 * OpenSky could not answer (breaker, timeout, 429, 5xx, auth, malformed):
 *   (a) last-good OpenSky for this scene whose snapshot is still current → 200 stale
 *   (b) adsb.lol → (c) adsb.fi → (d) airplanes.live (opt-in) regional → 200 degraded
 *   (e) the newest of: an older last-good OpenSky / regional snapshot → 200 stale
 *   (f) HTTP 503 with the structured reason.
 * Without a scene anchor only (a)/(e)/(f) can run.
 */
async function serveOpenSkyFallbackChain(
  res,
  { requestedMode, scene, key, reasonCode, reason, retryAfterSec, now },
) {
  const cached = lastGoodOpenSky(key, now);
  const serveStale = (entry) =>
    serveOpenSkyEntry(res, entry, {
      cacheStatus: 'STALE',
      status: 'stale',
      requestedMode,
      scene,
      now,
      reasonCode,
      reason,
      retryAfterSec,
    });
  if (cached && !openSkySourceIsStale(cached.value.sourceEpochMs, now)) {
    serveStale(cached);
    return;
  }
  if (
    await serveRegionalFallback(res, {
      requestedMode,
      scene,
      reasonCode,
      reason,
      retryAfterSec,
      now,
    })
  )
    return;
  const regional = staleRegionalRecord(scene);
  if (cached && (!regional || cached.fetchedAt >= regional.fetchedAt)) {
    serveStale(cached);
    return;
  }
  if (regional) {
    serveRegionalRecord(res, regional, {
      requestedMode,
      reasonCode: `${reasonCode}_regional_fallback`,
      reason,
      retryAfterSec,
      now,
    });
    return;
  }
  serveOpenSkyUnavailable(res, {
    requestedMode,
    reasonCode,
    reason,
    retryAfterSec,
    now,
  });
}

async function handleOpenSkyRequest(req, res, requestedMode) {
  const scene = sceneFor(adsbLolFallbackAnchor(req));
  const key = scene ? scene.key : 'world';
  const now = Date.now();
  const cached = lastGoodOpenSky(key, now);

  // 1. Fresh-enough cache (adaptive TTL): serve it without touching upstream.
  //    A 200 can still carry an old OpenSky snapshot; past 2 min the regional
  //    feed is more honest than coasting the frame.
  if (cached && now - cached.fetchedAt < _openskyTtlMs) {
    if (
      openSkySourceIsStale(cached.value.sourceEpochMs, now) &&
      (await serveRegionalFallback(res, {
        requestedMode,
        scene,
        reasonCode: 'opensky_snapshot_stale',
        reason: snapshotAgeReason(cached.value.sourceEpochMs, now),
        retryAfterSec: null,
        now,
      }))
    )
      return;
    serveOpenSkyEntry(res, cached, {
      cacheStatus: 'HIT',
      status: 'live',
      requestedMode,
      scene,
      now,
    });
    return;
  }

  // 2. OpenSky bypassed (breaker open or cooling down): no upstream attempt,
  //    the fallbacks answer immediately with the reason.
  const bypass = openSkyBypass(now);
  if (bypass) {
    await serveOpenSkyFallbackChain(res, {
      requestedMode,
      scene,
      key,
      ...bypass,
      now,
    });
    return;
  }

  // 3. Upstream attempt (one in flight per scene).
  const attempt = await fetchOpenSkyStates({ scene, requestedMode });
  if (attempt.ok) {
    const entry = attempt.entry;
    if (
      openSkySourceIsStale(entry.value.sourceEpochMs, now) &&
      (await serveRegionalFallback(res, {
        requestedMode,
        scene,
        reasonCode: 'opensky_snapshot_stale',
        reason: snapshotAgeReason(entry.value.sourceEpochMs, now),
        retryAfterSec: null,
        now,
      }))
    )
      return;
    serveOpenSkyEntry(res, entry, {
      cacheStatus: attempt.shared ? 'INFLIGHT' : 'MISS',
      status: 'live',
      requestedMode,
      scene,
      now,
    });
    return;
  }
  await serveOpenSkyFallbackChain(res, {
    requestedMode,
    scene,
    key,
    reasonCode: attempt.failure.reasonCode,
    reason: attempt.failure.reason,
    retryAfterSec: attempt.failure.retryAfterSec,
    now,
  });
}

/**
 * Vite plugin: OpenSky Network proxy with multi-mode auth, per-scene caching
 * and a regional fallback chain.
 *
 * Supports four auth modes controlled by OPENSKY_AUTH_MODE env:
 *   - 'oauth'  (default) — client_credentials bearer token; anonymous when
 *                OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET are unset
 *   - 'basic'  — HTTP Basic with OPENSKY_USERNAME / OPENSKY_PASSWORD
 *   - 'auto'   — try OAuth first, fall back to Basic, then anon
 *   - 'anon'   — no credentials
 *
 * Resolution order for GET /api/opensky?lat=&lon= (all data answers are 200
 * with X-Provider-Status / body.provider; see server/providers/common/upstream.js):
 *   fresh OpenSky bbox snapshot ............ live      (X-Flight-Source OpenSky Network)
 *   OpenSky bypassed / failed, last-good ... stale     (provider.error names the reason)
 *   adsb.lol / adsb.fi / airplanes.live .... degraded  (X-Flight-Source names the feed)
 *   older last-good (any source) ........... stale
 *   nothing at all ......................... HTTP 503  { error, provider: { status: 'unavailable' } }
 * The proxy never relays a raw upstream 5xx and never answers 502.
 *
 * Env: OPENSKY_BBOX_DEGREES (1.5), OPENSKY_TIMEOUT_MS (6000), OPENSKY_RETRIES (0),
 * OPENSKY_BREAKER_MS (600000), OPENSKY_FALLBACK_RADIUS_NM (250),
 * AIRPLANES_LIVE_ENABLED (false).
 *
 * @returns {import('vite').Plugin}
 */
export function openSkyProxy() {
  const installMiddleware = (server) => {
    server.middlewares.use('/api/opensky', async (req, res) => {
      const requestedMode = normalizeOpenSkyAuthMode(
        process.env.OPENSKY_AUTH_MODE,
      );
      try {
        await handleOpenSkyRequest(req, res, requestedMode);
      } catch (e) {
        console.error('[OpenSky Proxy]', e?.message || e);
        if (res.headersSent || res.writableEnded) return;
        const now = Date.now();
        const reason = `OpenSky proxy error (${String(e?.message || e).slice(0, 120)})`;
        try {
          await serveOpenSkyFallbackChain(res, {
            requestedMode,
            scene: sceneFor(adsbLolFallbackAnchor(req)),
            key: sceneFor(adsbLolFallbackAnchor(req))?.key || 'world',
            reasonCode: 'proxy_error',
            reason,
            retryAfterSec: null,
            now,
          });
        } catch (inner) {
          console.error('[OpenSky Proxy] fallback failed:', inner?.message);
          if (!res.headersSent && !res.writableEnded)
            serveOpenSkyUnavailable(res, {
              requestedMode,
              reasonCode: 'proxy_error',
              reason,
              retryAfterSec: null,
              now,
            });
        }
      }
    });
  };
  return {
    name: 'opensky-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
