import { normalizeAdsbLolPointResponse } from '../../../src/data/adsbLolFallback.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
} from '../common/http.js';
import { requiredFiniteQueryNumber } from '../common/query.js';
// ---------------------------------------------------------------------------
// OpenSky OAuth2 token + response cache state
// ---------------------------------------------------------------------------
/** @type {string|null} Current OAuth2 bearer token. */
let _openskyToken = null;
/** @type {number} Epoch-ms when the current token expires. */
let _openskyTokenExpiry = 0;
/** @type {Promise<string|null>|null} In-flight token refresh promise (coalesces concurrent callers). */
let _openskyTokenPromise = null;
/** @type {string|null} Cached upstream response body (JSON text). */
let _openskyCacheBody = null;
/** @type {number} HTTP status of the cached response. */
let _openskyCacheStatus = 0;
/** @type {number} Epoch-ms when the response was cached. */
let _openskyCacheTime = 0;
/** @type {{requestedMode:string,usedMode:string,reason:string}|null} Auth metadata for the cached response. */
let _openskyCacheMeta = null;
/** @type {number|null} Source snapshot epoch from the cached OpenSky body. */
let _openskyCacheSourceEpochMs = null;
/** TTL for the OpenSky response cache (ms). */
const OPENSKY_CACHE_MS = 9000;
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
/** Regional civilian fallback cache, keyed by a coarse 0.25° view anchor. */
const _adsbLolPointCache = new Map();
/** Per-anchor single-flight map for concurrent regional fallback requests. */
const _adsbLolPointInFlight = new Map();
const ADSBLOL_POINT_CACHE_MS = 12000;
const ADSBLOL_POINT_CACHE_MAX = 80;
const ADSBLOL_POINT_RADIUS_NM = 250;
const ADSBLOL_POINT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// A 200 response can still contain an old OpenSky snapshot. Past this point
// the viewport-scoped adsb.lol source is more honest and keeps local motion
// current instead of coasting a stale worldwide frame indefinitely.
const OPENSKY_SOURCE_STALE_MS = 120_000;

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

  // Wrap the async token fetch in a shared promise stored in _openskyTokenPromise
  _openskyTokenPromise = (async () => {
    try {
      const res = await fetch(
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
        },
      );

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_openskyAuthWarned) {
          const detail =
            data?.error_description || data?.error || `HTTP ${res.status}`;
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _openskyAuthWarned = true;
        }
        _openskyToken = null;
        _openskyTokenExpiry = 0;
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

async function fetchAdsbLolPointFallback(req) {
  const anchor = adsbLolFallbackAnchor(req);
  if (!anchor) return null;
  const roundedLat = Math.round(anchor.latitude * 4) / 4;
  const roundedLon = Math.round(anchor.longitude * 4) / 4;
  const cacheKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
  const cached = _adsbLolPointCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < ADSBLOL_POINT_CACHE_MS) {
    return { ...cached, cacheStatus: 'HIT' };
  }

  const request = coalesceProxyRequest(
    _adsbLolPointInFlight,
    cacheKey,
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const upstream = await fetch(
          `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${ADSBLOL_POINT_RADIUS_NM}`,
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'gods-eye-view-adsblol-regional-fallback/1.0',
            },
            signal: controller.signal,
          },
        );
        if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
        const payload = await readResponseJsonCapped(
          upstream,
          ADSBLOL_POINT_MAX_RESPONSE_BYTES,
        );
        const normalized = normalizeAdsbLolPointResponse(payload);
        const record = {
          body: JSON.stringify(normalized),
          cachedAt: Date.now(),
          count: normalized.states.length,
        };
        _adsbLolPointCache.delete(cacheKey);
        _adsbLolPointCache.set(cacheKey, record);
        while (_adsbLolPointCache.size > ADSBLOL_POINT_CACHE_MAX) {
          _adsbLolPointCache.delete(_adsbLolPointCache.keys().next().value);
        }
        return record;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );
  try {
    const record = await request.promise;
    return { ...record, cacheStatus: request.shared ? 'INFLIGHT' : 'MISS' };
  } catch (error) {
    if (!request.shared && error?.name !== 'AbortError') {
      console.warn('[adsb.lol Flights Fallback]', error?.message || error);
    }
    return cached ? { ...cached, cacheStatus: 'STALE' } : null;
  }
}

async function serveAdsbLolPointFallback(req, res, requestedMode, reason) {
  const fallback = await fetchAdsbLolPointFallback(req);
  if (!fallback) return false;
  res.writeHead(200, {
    ...buildOpenSkyHeaders({
      cacheStatus: fallback.cacheStatus,
      requestedMode,
      usedMode: 'adsblol-regional',
      reason,
    }),
    'X-Flight-Source': 'adsb.lol',
    'X-Flight-Coverage': `${ADSBLOL_POINT_RADIUS_NM}nm regional fallback`,
    'X-Flight-Count': String(fallback.count),
  });
  res.end(fallback.body);
  return true;
}

function openSkySourceEpochMs(body) {
  try {
    const seconds = Number(JSON.parse(body)?.time);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function openSkySourceIsStale(sourceEpochMs, now = Date.now()) {
  return (
    Number.isFinite(sourceEpochMs) &&
    now - sourceEpochMs > OPENSKY_SOURCE_STALE_MS
  );
}

/**
 * Vite plugin: OpenSky Network proxy with multi-mode auth and response caching.
 *
 * Supports four auth modes controlled by OPENSKY_AUTH_MODE env:
 *   - 'oauth'  (default) — client_credentials bearer token
 *   - 'basic'  — HTTP Basic with OPENSKY_USERNAME / OPENSKY_PASSWORD
 *   - 'auto'   — try OAuth first, fall back to Basic, then anon
 *   - 'anon'   — no credentials
 *
 * Successful responses are cached for OPENSKY_CACHE_MS (~9 s). On
 * upstream failure the proxy serves a stale cached response if available, or
 * a bounded 250 nm adsb.lol point snapshot around the current view anchor.
 *
 * @returns {import('vite').Plugin}
 */
export function openSkyProxy() {
  const installMiddleware = (server) => {
    server.middlewares.use('/api/opensky', async (req, res) => {
      try {
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        const now = Date.now();
        const inCooldown = now < _openskyCooldownUntil;
        // Fresh-enough cache (adaptive TTL) OR any cache during a 429
        // cooldown: serve it without touching upstream. Stale-during-cooldown
        // is deliberate (credit governor): last-good planes beat a dead layer.
        if (
          _openskyCacheBody &&
          (now - _openskyCacheTime < _openskyTtlMs || inCooldown)
        ) {
          if (
            openSkySourceIsStale(_openskyCacheSourceEpochMs, now) &&
            (await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              'opensky_snapshot_stale_regional_fallback',
            ))
          ) {
            return;
          }
          const cachedMeta = _openskyCacheMeta || {
            requestedMode,
            usedMode: 'unknown',
            reason: 'cached',
          };
          const isStale = now - _openskyCacheTime >= _openskyTtlMs;
          res.writeHead(
            _openskyCacheStatus || 200,
            buildOpenSkyHeaders({
              cacheStatus: isStale ? 'STALE' : 'HIT',
              requestedMode: cachedMeta.requestedMode || requestedMode,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: isStale
                ? 'rate_limited_serving_stale'
                : cachedMeta.reason || 'cached',
              staleSeconds: isStale
                ? (now - _openskyCacheTime) / 1000
                : undefined,
              retryAfterSeconds: inCooldown
                ? (_openskyCooldownUntil - now) / 1000
                : undefined,
            }),
          );
          res.end(_openskyCacheBody);
          return;
        }
        // Cooling down with nothing cached (cold start into a rate limit):
        // synthesize the 429 locally — hammering upstream mid-cooldown can't
        // succeed and just burns goodwill.
        if (inCooldown) {
          if (
            await serveAdsbLolPointFallback(
              req,
              res,
              requestedMode,
              'opensky_cooldown_regional_fallback',
            )
          )
            return;
          res.writeHead(
            429,
            buildOpenSkyHeaders({
              cacheStatus: 'COOLDOWN',
              requestedMode,
              usedMode: 'none',
              reason: 'rate_limited',
              retryAfterSeconds: (_openskyCooldownUntil - now) / 1000,
            }),
          );
          res.end(
            JSON.stringify({
              error: 'OpenSky rate limited; proxy cooling down.',
            }),
          );
          return;
        }

        const basicUser = process.env.OPENSKY_USERNAME || '';
        const basicPass = process.env.OPENSKY_PASSWORD || '';
        const hasBasicCreds = Boolean(basicUser && basicPass);
        const headers = { Accept: 'application/json' };
        let usedMode = 'anon';
        let reason = 'forced_anonymous';

        if (requestedMode === 'basic') {
          if (hasBasicCreds) {
            headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
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
          } else if (hasBasicCreds) {
            headers.Authorization = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
            usedMode = 'basic';
            reason = 'oauth_unavailable_fallback_basic';
          } else {
            reason = 'missing_oauth_and_basic_creds';
          }
        }

        let upstream = await fetch(
          'https://opensky-network.org/api/states/all?extended=1',
          { headers },
        );
        // Auto-mode fallback: if OAuth was rejected, retry with Basic credentials
        if (
          (upstream.status === 401 || upstream.status === 403) &&
          requestedMode === 'auto' &&
          usedMode === 'oauth' &&
          hasBasicCreds
        ) {
          const retryHeaders = {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`,
          };
          upstream = await fetch(
            'https://opensky-network.org/api/states/all?extended=1',
            { headers: retryHeaders },
          );
          usedMode = 'basic';
          reason = 'oauth_rejected_fallback_basic';
        }

        let body = await upstream.text();
        const sourceEpochMs = upstream.ok ? openSkySourceEpochMs(body) : null;
        if (
          upstream.ok &&
          openSkySourceIsStale(sourceEpochMs, now) &&
          (await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            'opensky_snapshot_stale_regional_fallback',
          ))
        ) {
          // Keep the last global snapshot available as a fail-soft cache,
          // but do not label or render it as a fresh live result.
          _openskyCacheBody = body;
          _openskyCacheStatus = upstream.status;
          _openskyCacheTime = now;
          _openskyCacheSourceEpochMs = sourceEpochMs;
          _openskyCacheMeta = { requestedMode, usedMode, reason };
          return;
        }
        if (upstream.status === 429) {
          reason = 'rate_limited';
          // Credit governor: honor OpenSky's retry-after (bounded 30 s … 30 min;
          // 2 min when the header is absent) — no upstream attempts until then.
          const retryAfterSec = Number(
            upstream.headers.get('x-rate-limit-retry-after-seconds'),
          );
          const cooldownMs = Math.min(
            Math.max(
              Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 120_000,
              30_000,
            ),
            30 * 60_000,
          );
          _openskyCooldownUntil = now + cooldownMs;
          // Serve the last-good body instead of the 429 when we have one —
          // the layer keeps rendering (STALE-cued) instead of dying.
          if (_openskyCacheBody && _openskyCacheStatus === 200) {
            res.writeHead(
              200,
              buildOpenSkyHeaders({
                cacheStatus: 'STALE',
                requestedMode,
                usedMode,
                reason: 'rate_limited_serving_stale',
                staleSeconds: (now - _openskyCacheTime) / 1000,
                retryAfterSeconds: cooldownMs / 1000,
              }),
            );
            res.end(_openskyCacheBody);
            return;
          }
        }

        if (!upstream.ok && !_openskyCacheBody) {
          const servedFallback = await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            `opensky_http_${upstream.status}_regional_fallback`,
          );
          if (servedFallback) return;
        }

        if (upstream.status === 401 || upstream.status === 403) {
          if (requestedMode === 'basic' && !hasBasicCreds) {
            body = JSON.stringify({
              error:
                'OpenSky auth missing. Basic mode requires OPENSKY_USERNAME and OPENSKY_PASSWORD.',
            });
            reason = 'missing_basic_creds';
          } else if (requestedMode === 'oauth' && usedMode !== 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth mode requires valid OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.',
            });
            reason = 'oauth_invalid_or_missing';
          } else if (usedMode === 'basic') {
            body = JSON.stringify({
              error: 'OpenSky auth invalid. Username/password were rejected.',
            });
            reason = 'basic_invalid_credentials';
          } else if (usedMode === 'oauth') {
            body = JSON.stringify({
              error:
                'OpenSky auth invalid. OAuth client credentials were rejected.',
            });
            reason = 'oauth_invalid_credentials';
          } else if (requestedMode === 'auto' && !hasBasicCreds) {
            body = JSON.stringify({
              error:
                'OpenSky auth missing. Provide basic credentials or valid OAuth client credentials.',
            });
            reason = 'missing_oauth_and_basic_creds';
          } else {
            body = JSON.stringify({
              error: 'OpenSky auth required.',
            });
            reason = 'auth_required';
          }
        }

        // Refine the reason string to reflect the actual outcome
        if (upstream.ok && reason === 'forced_anonymous') {
          reason = 'anonymous_ok';
        } else if (
          upstream.ok &&
          usedMode === 'basic' &&
          reason === 'basic_credentials'
        ) {
          reason = 'basic_ok';
        } else if (
          upstream.ok &&
          usedMode === 'oauth' &&
          reason === 'oauth_token'
        ) {
          reason = 'oauth_ok';
        }

        // Only cache successful responses — error responses (401/403/429/5xx)
        // should not be served from cache on subsequent requests
        if (upstream.ok) {
          _openskyCacheBody = body;
          _openskyCacheStatus = upstream.status;
          _openskyCacheTime = now;
          _openskyCacheSourceEpochMs = sourceEpochMs;
          _openskyCacheMeta = {
            requestedMode,
            usedMode,
            reason,
          };
          // Credit governor: adapt the cache TTL to the remaining daily
          // budget so a continuously-open app stretches its polls instead of
          // exhausting the quota mid-day. Success also clears any cooldown.
          const remaining = Number(
            upstream.headers.get('x-rate-limit-remaining'),
          );
          _openskyTtlMs = openskyAdaptiveTtlMs(remaining);
          _openskyCooldownUntil = 0;
        }

        res.writeHead(
          upstream.status,
          buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode,
            reason,
          }),
        );
        res.end(body);
      } catch (e) {
        console.error('[OpenSky Proxy]', e.message);
        if (_openskyCacheBody) {
          const cachedMeta = _openskyCacheMeta || {
            requestedMode: normalizeOpenSkyAuthMode(
              process.env.OPENSKY_AUTH_MODE,
            ),
            usedMode: 'unknown',
            reason: 'cached_stale',
          };
          res.writeHead(
            _openskyCacheStatus || 200,
            buildOpenSkyHeaders({
              cacheStatus: 'STALE',
              requestedMode:
                cachedMeta.requestedMode || OPENSKY_AUTH_MODE_DEFAULT,
              usedMode: cachedMeta.usedMode || 'unknown',
              reason: cachedMeta.reason || 'cached_stale',
            }),
          );
          res.end(_openskyCacheBody);
          return;
        }
        const requestedMode = normalizeOpenSkyAuthMode(
          process.env.OPENSKY_AUTH_MODE,
        );
        if (
          await serveAdsbLolPointFallback(
            req,
            res,
            requestedMode,
            'opensky_proxy_error_regional_fallback',
          )
        )
          return;
        res.writeHead(
          502,
          buildOpenSkyHeaders({
            cacheStatus: 'MISS',
            requestedMode,
            usedMode: 'error',
            reason: 'proxy_error',
          }),
        );
        res.end(JSON.stringify({ error: 'OpenSky proxy error' }));
      }
    });
  };
  return {
    name: 'opensky-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
