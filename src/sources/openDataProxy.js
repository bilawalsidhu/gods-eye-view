/**
 * Shared upstream-fetch plumbing for the France/EU C3 open-data proxies.
 *
 * Every public operator is a stranger: no key, no SLA, occasionally a 302 to
 * a slightly different path, occasionally a 500. This module implements the
 * one behaviour every one of those proxies needs:
 *
 *  - the browser NEVER names an upstream URL; it names a registered route and
 *    the proxy resolves the URL from a server-side allow-list,
 *  - every upstream read is byte-capped (readResponseJsonCapped /
 *    readResponseTextCapped) before it reaches the process heap,
 *  - a per-route memory cache with a TTL keeps a browser poll loop from
 *    hammering a public operator,
 *  - a fixed-window admission limiter bounds how often the process may ask the
 *    operator at all, no matter how many tabs are open,
 *  - consecutive failures push the next permitted attempt out on a cooldown
 *    ladder (serve-stale-on-failure meanwhile),
 *  - redirects are followed manually and must stay on the same https origin,
 *    so an upstream cannot bounce the proxy at a third party.
 *
 * It is deliberately generic: the five proxies differ in payload shape, not
 * in transport behaviour.
 */

import {
  coalesceProxyRequest,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './httpBody.js';
import { makeRateLimiter } from './rateLimit.js';

/** Max redirects followed for one upstream hop chain. */
export const OPEN_DATA_MAX_REDIRECTS = 3;
/** Default upstream timeout for one request. */
export const OPEN_DATA_TIMEOUT_MS = 20_000;
/** Default admission window. */
export const OPEN_DATA_ADMISSION_WINDOW_MS = 60_000;

/**
 * Backoff ladder after consecutive upstream failures.
 * 1st failure -> 30 s, 2nd -> 60 s, 3rd -> 120 s, then 5 min.
 * @param {number} failures Consecutive failure count (>= 1).
 * @returns {number} Milliseconds to wait before the next attempt.
 */
export function nextOpenDataBackoffMs(failures) {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1;
  if (n === 1) return 30_000;
  if (n === 2) return 60_000;
  if (n === 3) return 120_000;
  return 300_000;
}

/**
 * Whether a redirect target stays on the registered upstream's own origin.
 * A redirect to another host is refused: the allow-list is the contract.
 * @param {string} origin Registered upstream origin.
 * @param {string|null|undefined} location Raw Location header.
 * @returns {{ok: boolean, url?: string, reason?: string}}
 */
export function openDataRedirectDecision(origin, location) {
  const raw = String(location || '').trim();
  if (!raw) return { ok: false, reason: 'missing-location' };
  let target;
  try {
    target = new URL(raw, origin);
  } catch {
    return { ok: false, reason: 'bad-location' };
  }
  if (target.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  let base;
  try {
    base = new URL(origin);
  } catch {
    return { ok: false, reason: 'bad-origin' };
  }
  if (target.origin !== base.origin)
    return { ok: false, reason: 'cross-origin' };
  return { ok: true, url: target.toString() };
}

/**
 * Build one cached, admission-limited upstream JSON service.
 *
 * @param {object} options
 * @param {string} options.id Stable route id (also the cache/admission key).
 * @param {Map<string,string>|Record<string,string>} options.routes
 *   Route segment -> absolute upstream URL. Only these are reachable.
 * @param {(route: string, fetchImpl: typeof fetch) => Promise<any>} [options.loader]
 *   Custom loader for a route. When present it owns the upstream sweep (a
 *   paged catalogue, say) and the generic service only supplies the cache,
 *   admission limiter, backoff and error envelope around it.
 * @param {number} [options.ttlMs=300000] Freshness window of a cached body.
 * @param {number} [options.maxBytes=2000000] Hard cap on one upstream body.
 * @param {number} [options.maxPerWindow=8] Upstream requests per route/window.
 * @param {number} [options.globalMaxPerWindow=40] Upstream requests/window total.
 * @param {number} [options.timeoutMs=20000] One upstream request timeout.
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {(body: any, route: string) => any} [options.normalize]
 *   Optional server-side normalization applied before the body is cached.
 * @param {(error: Error) => {status: number, payload: any}} [options.onError]
 *   Maps an upstream failure to a response status/payload.
 * @param {() => ({status: number, payload: any}|null)} [options.preflight]
 *   Cheap local gate (for example "operator key missing"). Returning a result
 *   short-circuits the upstream entirely.
 * @returns {{handle: (request: Request) => Promise<Response>, close: () => void}}
 */
export function createOpenDataService({
  id,
  routes,
  loader = null,
  ttlMs = 300_000,
  maxBytes = 2_000_000,
  maxPerWindow = 8,
  globalMaxPerWindow = 40,
  timeoutMs = OPEN_DATA_TIMEOUT_MS,
  fetchImpl = fetch,
  normalize = null,
  onError = null,
  preflight = null,
} = {}) {
  if (!id) throw new TypeError('An open-data service needs an id');
  const routeMap =
    routes instanceof Map
      ? new Map(routes)
      : new Map(Object.entries(routes || {}));
  if (!routeMap.size && typeof loader !== 'function')
    throw new TypeError('An open-data service needs routes or a loader');

  /** @type {Map<string, {at: number, body: string, host: string}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();
  /** @type {Map<string, {failures: number, nextAttemptAt: number, reason: string}>} */
  const cooldown = new Map();
  const controllers = new Set();
  const admit = makeRateLimiter({
    windowMs: OPEN_DATA_ADMISSION_WINDOW_MS,
    max: maxPerWindow,
    globalMax: globalMaxPerWindow,
  });
  let closed = false;

  const reply = (status, payload, headers = {}) =>
    new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...headers,
        },
      },
    );

  const cacheHeaders = (state, host, at) => ({
    'X-GEV-Cache': state,
    'X-GEV-Upstream-Host': host || 'unknown',
    'X-GEV-Cache-At': at ? new Date(at).toISOString() : '',
  });

  function noteFailure(route, reason, now) {
    const previous = cooldown.get(route);
    const failures = (previous?.failures || 0) + 1;
    const wait = nextOpenDataBackoffMs(failures);
    cooldown.set(route, { failures, nextAttemptAt: now + wait, reason });
    return wait;
  }

  async function fetchUpstream(url, signal) {
    let current = url;
    for (let hop = 0; hop <= OPEN_DATA_MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        signal,
        redirect: 'manual',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      const location = response.headers.get('location');
      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) return response;
      const decision = openDataRedirectDecision(url, location);
      try {
        await response.body?.cancel();
      } catch {
        /* no-op */
      }
      if (!decision.ok)
        throw new Error(`upstream redirect refused (${decision.reason})`);
      if (hop === OPEN_DATA_MAX_REDIRECTS) {
        throw new Error('upstream redirected too many times');
      }
      current = decision.url;
    }
    throw new Error('upstream redirected too many times');
  }

  async function refresh(route, url, now) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchUpstream(url, controller.signal);
      if (closed) throw new Error('Open data provider closed');
      if (!response.ok) {
        const error = new Error(`upstream HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
      }
      const payload = await readResponseJsonCapped(
        response,
        maxBytes,
        controller.signal,
      );
      if (closed) throw new Error('Open data provider closed');
      const shaped = normalize ? normalize(payload, route) : payload;
      const entry = {
        at: now,
        body: JSON.stringify(shaped),
        host: new URL(url).hostname,
      };
      cache.set(route, entry);
      cooldown.delete(route);
      return entry;
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
    }
  }

  async function refreshWithLoader(route, load, now) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const shaped = await load(route, fetchImpl, controller.signal);
      if (closed) throw new Error('Open data provider closed');
      const entry = {
        at: now,
        body: JSON.stringify(shaped),
        host: 'loader',
      };
      cache.set(route, entry);
      cooldown.delete(route);
      return entry;
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
    }
  }

  async function handle(incoming) {
    if (closed) return reply(503, { error: 'Open data provider closed' });
    if (incoming.method !== 'GET') {
      return reply(405, { error: 'Method Not Allowed' });
    }
    const url = new URL(incoming.url);
    const route = decodeURIComponent(
      url.pathname.split('/').filter(Boolean).pop() || '',
    );
    if (!routeMap.has(route) && typeof loader !== 'function') {
      return reply(404, { error: 'Unknown data route' });
    }

    const local = preflight?.(route);
    if (local) return reply(local.status, local.payload);

    const upstreamUrl = routeMap.get(route);
    const now = Date.now();
    const cached = cache.get(route);
    if (cached && now - cached.at < ttlMs) {
      return reply(
        200,
        cached.body,
        cacheHeaders('HIT', cached.host, cached.at),
      );
    }

    const waiting = cooldown.get(route);
    if (waiting && waiting.nextAttemptAt > now && !inFlight.has(route)) {
      if (cached) {
        return reply(
          200,
          cached.body,
          cacheHeaders('STALE-ERROR', cached.host, cached.at),
        );
      }
      return reply(
        503,
        {
          error: 'Upstream cooling down',
          route,
          retryInSec: Math.max(
            1,
            Math.ceil((waiting.nextAttemptAt - now) / 1000),
          ),
        },
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((waiting.nextAttemptAt - now) / 1000)),
          ),
        },
      );
    }

    if (!inFlight.has(route) && !admit(route)) {
      if (cached) {
        return reply(
          200,
          cached.body,
          cacheHeaders('STALE-ERROR', cached.host, cached.at),
        );
      }
      return reply(429, { error: 'Upstream rate limited', route });
    }

    const request = coalesceProxyRequest(inFlight, route, () =>
      typeof loader === 'function'
        ? refreshWithLoader(route, loader, now)
        : refresh(route, upstreamUrl, now),
    );
    try {
      const fresh = await request.promise;
      return reply(
        200,
        fresh.body,
        cacheHeaders(
          request.shared ? 'INFLIGHT' : 'MISS',
          fresh.host,
          fresh.at,
        ),
      );
    } catch (error) {
      if (!request.shared) {
        const wait = noteFailure(
          route,
          error?.message || String(error),
          Date.now(),
        );
        console.warn(
          `[${id}-proxy] ${route} unavailable: ${error?.message || error} — next attempt in ${Math.round(wait / 1000)}s`,
        );
      }
      if (cached) {
        return reply(
          200,
          cached.body,
          cacheHeaders('STALE-ERROR', cached.host, cached.at),
        );
      }
      const mapped = onError?.(error);
      if (mapped) return reply(mapped.status, mapped.payload);
      return reply(error?.upstreamStatus ? 502 : 504, {
        error: 'Upstream unavailable',
        route,
        detail: error?.message || String(error),
      });
    }
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    cache.clear();
    cooldown.clear();
    inFlight.clear();
  }

  return { handle, close, id };
}

/**
 * Read one upstream body as text under a byte cap (XML feeds).
 * @param {Response} response Upstream response.
 * @param {number} maxBytes Hard byte ceiling.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<string>}
 */
export function readOpenDataText(response, maxBytes, signal) {
  return readResponseTextCapped(response, maxBytes, signal);
}
