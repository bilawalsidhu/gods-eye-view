import { createTransitHistory } from './transitHistoryStore.js';
/**
 * GTFS-Realtime transit proxy for the Transit data layer.
 *
 * Only URLs registered in `src/data/transitFeeds.js` are ever fetched — the
 * browser names a registered id, never a URL. Pure request/cache mechanics
 * live in `src/data/transitProxy.js` so the offline suite covers them.
 */

import { coalesceProxyRequest, readResponseBytesCapped } from './httpBody.js';
import { makeRateLimiter } from './rateLimit.js';
import { publicTransitCatalog } from '../data/transitFeeds.js';
import {
  TRANSIT_ADMISSION_MAX_GLOBAL,
  TRANSIT_ADMISSION_MAX_PER_FEED,
  TRANSIT_ADMISSION_WINDOW_MS,
  TRANSIT_MAX_REDIRECTS,
  TRANSIT_PROXY_MAX_BODY_BYTES,
  TRANSIT_PROXY_TIMEOUT_MS,
  TRANSIT_PROXY_TTL_MS,
  TransitFeedShapeError,
  buildTransitSnapshot,
  isAcceptableTransitUpstreamUrl,
  isTransitRedirectStatus,
  nextTransitBackoffMs,
  resolveTransitRoute,
  transitCacheState,
  transitRedirectDecision,
  transitResponseHeaders,
  transitUpstreamHeaders,
} from '../data/transitProxy.js';

/**
 * Fetch a registered feed, resolving each redirect hop BEFORE following it.
 *
 * `redirect: 'follow'` hands the hop to the runtime and only lets us inspect
 * where it landed — by which point a disallowed host has already been
 * contacted and has already answered. Each hop is therefore requested with
 * `redirect: 'manual'` and its `Location` checked against the feed's own https
 * origin first, the rule the CCTV frame proxy applies to camera images.
 *
 * @param {object} feed Registry entry.
 * @param {AbortSignal} signal Abort signal for the whole hop chain.
 * @param {typeof fetch} [fetchImpl] Injected for tests.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators] Cached validators.
 * @returns {Promise<{response: Response, finalUrl: string}>}
 */
export async function fetchTransitFeed(
  feed,
  signal,
  fetchImpl = fetch,
  validators = null,
) {
  let current = feed.url;
  for (let hop = 0; hop <= TRANSIT_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      signal,
      headers: transitUpstreamHeaders(feed, validators),
      redirect: 'manual',
    });
    // Only a real redirect is followed. A 304 is the successful answer to our
    // own conditional request and has no Location; sending it round this loop
    // fails a feed that is simply unchanged.
    if (!isTransitRedirectStatus(response?.status)) {
      return { response, finalUrl: current };
    }
    const decision = transitRedirectDecision(
      feed.url,
      current,
      response.headers.get('location'),
    );
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!decision.ok) throw new Error(`upstream ${decision.reason}`);
    if (hop === TRANSIT_MAX_REDIRECTS) {
      throw new Error('upstream redirected too many times');
    }
    current = decision.url;
  }
  throw new Error('upstream redirected too many times');
}

/**
 * Vite plugin: GTFS-Realtime VehiclePositions proxy for the Transit layer.
 *
 *   GET /api/transit/feeds              → public catalog (coverage + credit)
 *   GET /api/transit/vehicles/<feedId>  → decoded snapshot as JSON
 *
 * Only URLs in `src/data/transitFeeds.js` are ever fetched — the browser
 * names a registered id, never a URL (SECURITY.md). Redirects are resolved hop
 * by hop and must stay on the feed's own https origin. Bytes are capped at
 * TRANSIT_PROXY_MAX_BODY_BYTES and decoded server-side, so the browser never
 * parses protobuf. Per feed: 15 s memory cache, single-flight refresh, and
 * serve-stale-on-failure for up to 10 minutes (the launch-library pattern).
 * No disk cache — transit positions are worthless after a few minutes.
 *
 * Two backstops sit in front of every upstream request. A fixed-window
 * admission limiter bounds how often this process may ask any one operator,
 * and all of them together, no matter how many browser tabs are open. A
 * per-feed cooldown ladder then keeps a feed that is genuinely down from being
 * re-asked once per poll for a whole session: consecutive failures push the
 * next permitted attempt out to five minutes, and one success resets it.
 *
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{handle: (request: Request) => Promise<Response>, close: () => void}}
 */
export function createTransitService({ fetchImpl = fetch } = {}) {
  /** @type {Map<string, {at:number, body:string, host:string}>} feedId → snapshot */
  const cache = new Map();
  const history = createTransitHistory();
  const admitHistory = makeRateLimiter({
    windowMs: 60000,
    max: 30,
    globalMax: 120,
  });
  let closed = false;
  const inFlight = new Map();
  const controllers = new Set();
  /** @type {Map<string, {failures:number, nextAttemptAt:number, reason:string}>} */
  const cooldown = new Map();
  const admit = makeRateLimiter({
    windowMs: TRANSIT_ADMISSION_WINDOW_MS,
    max: TRANSIT_ADMISSION_MAX_PER_FEED,
    globalMax: TRANSIT_ADMISSION_MAX_GLOBAL,
  });
  const ttlSeconds = Math.ceil(TRANSIT_PROXY_TTL_MS / 1000);

  function reply(status, body, headers) {
    return new Response(body, { status, headers });
  }

  function noteFailure(feedId, reason, now) {
    const previous = cooldown.get(feedId);
    const failures = (previous?.failures || 0) + 1;
    const wait = nextTransitBackoffMs(failures);
    cooldown.set(feedId, { failures, nextAttemptAt: now + wait, reason });
    return wait;
  }

  async function refresh(feed, now) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      TRANSIT_PROXY_TIMEOUT_MS,
    );
    const previous = cache.get(feed.id);
    try {
      const { response, finalUrl } = await fetchTransitFeed(
        feed,
        controller.signal,
        fetchImpl,
        previous
          ? { etag: previous.etag, lastModified: previous.lastModified }
          : null,
      );
      if (closed) throw new Error('Transit provider closed');
      if (!isAcceptableTransitUpstreamUrl(finalUrl)) {
        throw new Error('upstream is not https');
      }
      // Nothing changed upstream: keep the snapshot we have and restart its
      // freshness window rather than asking for a body we already hold.
      if (response.status === 304 && previous) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        // `at` restarts the freshness window; `contactedAt` records that the
        // operator answered just now. They are different facts: the body still
        // carries the fetch time of the payload it holds, and reading that as
        // "when did we last hear from them" would age a feed that is answering
        // every single request into silence.
        const revalidated = { ...previous, at: now, contactedAt: now };
        cache.set(feed.id, revalidated);
        cooldown.delete(feed.id);
        return revalidated;
      }
      if (!response.ok) {
        const error = new Error(`upstream HTTP ${response.status}`);
        error.upstreamStatus = response.status;
        throw error;
      }
      const bytes = await readResponseBytesCapped(
        response,
        TRANSIT_PROXY_MAX_BODY_BYTES,
      );
      const snapshot = buildTransitSnapshot(feed, bytes, now);
      if (closed) throw new Error('Transit provider closed');
      history.ingest(feed, snapshot.vehicles, Date.now());
      const entry = {
        at: snapshot.fetchedAt,
        contactedAt: snapshot.fetchedAt,
        body: JSON.stringify(snapshot),
        host: new URL(finalUrl).hostname,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
      cache.set(feed.id, entry);
      cooldown.delete(feed.id);
      return entry;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      controllers.delete(controller);
    }
  }

  async function handle(incoming) {
    const url = new URL(incoming.url);
    if (!url.pathname.startsWith('/api/transit/'))
      return reply(404, JSON.stringify({ error: 'Unknown transit feed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    const req = {
      method: incoming.method,
      url: url.pathname.slice('/api/transit'.length) + url.search,
    };
    if (closed)
      return reply(503, JSON.stringify({ error: 'Transit provider closed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    if (req.method !== 'GET') {
      return reply(
        405,
        JSON.stringify({ error: 'Method Not Allowed' }),
        transitResponseHeaders('NONE'),
      );
    }
    const route = resolveTransitRoute(req.url);
    if (!route) {
      return reply(404, JSON.stringify({ error: 'Unknown transit feed' }), {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
    }
    if (route.route === 'feeds') {
      return reply(200, JSON.stringify({ feeds: publicTransitCatalog() }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      });
    }
    const { feed } = route;
    const now = Date.now();
    if (route.route === 'trail') {
      if (!admitHistory(feed.id)) {
        return reply(
          429,
          JSON.stringify({ error: 'Transit history read limit reached' }),
          {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60',
          },
        );
      }
      return reply(
        200,
        JSON.stringify(history.get(feed.id, route.vehicleId, now)),
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      );
    }
    const cached = cache.get(feed.id);
    const state = transitCacheState(cached, now);
    if (state === 'fresh') {
      return reply(
        200,
        cached.body,
        transitResponseHeaders('HIT', cached.host, cached.contactedAt),
      );
    }

    // Answer without contacting the operator: the cached snapshot when there
    // is one, otherwise an honest "unavailable, come back in N seconds".
    const answerWithoutUpstream = (reason, retryAfterS) => {
      if (state === 'stale' && cached) {
        // The contact time stays as old as it is: a feed being served from
        // cache during an outage has NOT answered, and saying otherwise
        // would keep a dead feed on the globe.
        return reply(
          200,
          cached.body,
          transitResponseHeaders(
            'STALE-ERROR',
            cached.host,
            cached.contactedAt,
          ),
        );
      }
      return reply(
        503,
        JSON.stringify({
          error: 'Transit feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
          'X-Transit-Backoff': reason,
        },
      );
    };

    const waiting = cooldown.get(feed.id);
    if (waiting && waiting.nextAttemptAt > now && !inFlight.has(feed.id)) {
      return answerWithoutUpstream(
        'cooldown',
        Math.max(1, Math.ceil((waiting.nextAttemptAt - now) / 1000)),
      );
    }
    if (!inFlight.has(feed.id) && !admit(feed.id)) {
      return answerWithoutUpstream('rate-limited', ttlSeconds);
    }

    const request = coalesceProxyRequest(inFlight, feed.id, () =>
      refresh(feed, now),
    );
    try {
      const fresh = await request.promise;
      return reply(
        200,
        fresh.body,
        transitResponseHeaders(
          request.shared ? 'INFLIGHT' : 'MISS',
          fresh.host,
          fresh.contactedAt,
        ),
      );
    } catch (error) {
      const differential = error instanceof TransitFeedShapeError;
      // A shape fault condemns what we already hold. The cached copy was
      // decoded under the assumption this feed is a full snapshot, and that
      // assumption has just been shown false — leaving it in place would let
      // the very next request serve it back as a 200.
      if (differential) cache.delete(feed.id);
      if (!request.shared) {
        const wait = noteFailure(
          feed.id,
          error?.message || String(error),
          Date.now(),
        );
        console.warn(
          `[transit-proxy] ${feed.id} unavailable: ${error?.message || error} — next attempt in ${Math.round(wait / 1000)}s`,
        );
      }
      // A differential feed is a shape fault, not an outage: serving the old
      // snapshot would hide a feed this decoder must not render at all.
      if (state === 'stale' && cached && !differential) {
        // The contact time is the last SUCCESSFUL one. This request failed,
        // so it does not advance — otherwise a dead feed would look like one
        // answering on time.
        return reply(
          200,
          cached.body,
          transitResponseHeaders(
            'STALE-ERROR',
            cached.host,
            cached.contactedAt,
          ),
        );
      }
      const pending = cooldown.get(feed.id);
      const retryAfterS = pending
        ? Math.max(1, Math.ceil((pending.nextAttemptAt - Date.now()) / 1000))
        : ttlSeconds;
      return reply(
        differential ||
          error?.code === 'RESPONSE_TOO_LARGE' ||
          Number.isInteger(error?.upstreamStatus)
          ? 502
          : 504,
        JSON.stringify({
          error: differential
            ? 'Transit feed is differential and is not supported'
            : 'Transit feed unavailable',
          feedId: feed.id,
          retryInSec: retryAfterS,
        }),
        {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-GEV-Cache': 'NONE',
          'Retry-After': String(retryAfterS),
        },
      );
    }
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    history.clear();
    cache.clear();
    cooldown.clear();
  }
  return { handle, close };
}
