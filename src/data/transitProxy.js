import { validTransitIdentifier } from '../sources/transitHistory.js';
export {
  validTransitIdentifier,
  fetchTransitHistory,
} from '../sources/transitHistory.js';

/**
 * @module transitProxy
 * @description Pure server-side mechanics for the `/api/transit` proxy.
 *
 * Kept free of Vite/Node middleware state (the terrainHeightsProxy pattern)
 * so path resolution, snapshot shaping, and the cache/stale policy can be
 * exercised by the offline node:test suite. The middleware in vite.config.js
 * only does I/O: fetch the registered upstream, hand the bytes here, send.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  decodeVehiclePositions,
} from './gtfsRealtime.js';
import { getTransitFeed } from './transitFeeds.js';
import {
  normalizeGtfsRtAlertsJson,
  normalizeMbtaRoutePatterns,
} from './transitNetwork.js';

/** Fresh window: a snapshot younger than this is served without refetching. */
export const TRANSIT_PROXY_TTL_MS = 15_000;
/** Serve-stale window: after an upstream failure, a snapshot this old still ships (marked stale). */
export const TRANSIT_PROXY_STALE_MAX_MS = 10 * 60_000;
/** Upstream fetch timeout. National feeds (Entur ≈ 1.4 MB) need headroom. */
export const TRANSIT_PROXY_TIMEOUT_MS = 15_000;
/** Hard cap on upstream bytes: the largest registered feed is well under 1 MB. */
export const TRANSIT_PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Redirect hops followed before a feed is declared unreachable. */
export const TRANSIT_MAX_REDIRECTS = 3;
/**
 * The 3xx codes that actually mean "go somewhere else". 304 is NOT one of them:
 * it is the successful answer to a conditional request and carries no Location,
 * so treating the whole 3xx range as a redirect turns every healthy unchanged
 * feed into a failure and walks it up the backoff ladder.
 */
export const TRANSIT_REDIRECT_STATUSES = Object.freeze([
  301, 302, 303, 307, 308,
]);

/**
 * Whether an upstream status is a redirect this proxy should follow.
 * @param {number} status
 * @returns {boolean}
 */
export function isTransitRedirectStatus(status) {
  return TRANSIT_REDIRECT_STATUSES.includes(Number(status));
}
/**
 * Admission window for upstream requests. One browser polls a feed every 15 s
 * (4/min); the allowance leaves room for a second tab and a manual reload, and
 * the global figure bounds what this process can ask of ALL operators at once.
 */
export const TRANSIT_ADMISSION_WINDOW_MS = 60_000;
export const TRANSIT_ADMISSION_MAX_PER_FEED = 8;
export const TRANSIT_ADMISSION_MAX_GLOBAL = 40;
/**
 * Cooldown ladder after consecutive upstream failures, in ms. A cold feed that
 * is simply down must not be re-asked once per poll for the whole session: the
 * first retry is quick, the last rung is five minutes, and the ladder resets on
 * the first success.
 */
export const TRANSIT_BACKOFF_LADDER_MS = Object.freeze([
  5_000, 15_000, 60_000, 300_000,
]);

/**
 * Route geometry and alerts are separate resources with their own clocks.
 *
 * Routes change a few times a year: twelve hours fresh, and a week of
 * serve-stale so an operator outage never blanks the map. Alerts change by
 * the minute: one minute fresh (the operator's own CDN refresh), and half an
 * hour of serve-stale, after which an alert list is too old to present as
 * current and the proxy says so instead.
 */
export const TRANSIT_NETWORK_POLICY = Object.freeze({
  routes: Object.freeze({
    ttlMs: 12 * 60 * 60_000,
    staleMaxMs: 7 * 24 * 60 * 60_000,
    // The full MBTA pattern catalog is ~2.4 MB decoded.
    maxBytes: 12 * 1024 * 1024,
    timeoutMs: 30_000,
  }),
  alerts: Object.freeze({
    ttlMs: 60_000,
    staleMaxMs: 30 * 60_000,
    // MBTA's enhanced alerts are ~0.6 MB.
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 15_000,
  }),
});

/** Accept header for the JSON network resources (JSON:API and plain JSON). */
export const TRANSIT_NETWORK_ACCEPT =
  'application/vnd.api+json, application/json;q=0.9, */*;q=0.1';

/**
 * Resolve `/vehicles/<feedId>` (the path after the `/api/transit` mount) to a
 * registered feed. Anything else — a different route, an unknown id, path
 * tricks, a query string — resolves to null and the caller 404s.
 * @param {string} url Request URL relative to the mount point.
 * `/routes/<feedId>` and `/alerts/<feedId>` resolve only for a feed whose
 * registry entry carries that network resource; every other feed 404s.
 * @returns {{ route: 'feeds' } | { route: 'vehicles', feed: object } |
 *   { route: 'routes'|'alerts', feed: object, upstreamUrl: string } | null}
 */
export function resolveTransitRoute(url) {
  const pathname = String(url || '').split('?')[0];
  if (pathname === '/feeds' || pathname === '/feeds/')
    return { route: 'feeds' };
  const network = /^\/(routes|alerts)\/([^/]+)\/?$/.exec(pathname);
  if (network) {
    let networkId;
    try {
      networkId = decodeURIComponent(network[2]);
    } catch {
      return null;
    }
    const networkFeed = getTransitFeed(networkId);
    const upstreamUrl =
      network[1] === 'routes'
        ? networkFeed?.network?.routesUrl
        : networkFeed?.network?.alertsUrl;
    return networkFeed && typeof upstreamUrl === 'string'
      ? { route: network[1], feed: networkFeed, upstreamUrl }
      : null;
  }
  const match = /^\/(vehicles|trail)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  let id, vehicleId;
  try {
    id = decodeURIComponent(match[2]);
    vehicleId = match[3] === undefined ? null : decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  const feed = getTransitFeed(id);
  if (!feed) return null;
  if (match[1] === 'vehicles')
    return vehicleId === null ? { route: 'vehicles', feed } : null;
  return feed.historyRetention === true && validTransitIdentifier(vehicleId)
    ? { route: 'trail', feed, vehicleId }
    : null;
}

/**
 * Request headers for one upstream fetch.
 *
 * Three of these are obligations, not politeness. Feeds that ask consumers to
 * identify themselves get their header from the registry (Entur requires
 * `ET-Client-Name`; OVapi asks that the User-Agent say who you are). OVapi also
 * asks anyone polling faster than once a minute to send conditional-request
 * validators and to accept gzip, so both are sent to every feed: harmless
 * where it is not asked for, and it spares each operator a full body whenever
 * nothing has changed.
 *
 * @param {object} feed Registry entry.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators] From the cached snapshot.
 * @returns {Record<string, string>}
 */
export function transitUpstreamHeaders(feed, validators = null, accept = null) {
  return {
    'User-Agent':
      'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    Accept:
      accept ||
      'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1',
    'Accept-Encoding': 'gzip',
    ...(validators?.etag ? { 'If-None-Match': validators.etag } : {}),
    ...(validators?.lastModified
      ? { 'If-Modified-Since': validators.lastModified }
      : {}),
    ...(feed?.headers || {}),
  };
}

/**
 * Only https upstreams are fetched.
 * @param {string} url Request or response URL.
 * @returns {boolean}
 */
export function isAcceptableTransitUpstreamUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decide whether one redirect hop may be followed, BEFORE it is requested.
 *
 * Checking the FINAL url after `redirect: 'follow'` is too late: by then the
 * disallowed host has already been contacted, has already seen this server's
 * request, and has already answered. So every hop is resolved here first and a
 * hop that leaves the feed's own origin, or drops to plain http, is refused —
 * the same rule the CCTV frame proxy applies to camera images.
 *
 * @param {string} originUrl The registered feed URL (defines the allowed origin).
 * @param {string} currentUrl The URL that produced this redirect (for relative Location).
 * @param {string|null} location Raw `Location` header value.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function transitRedirectDecision(originUrl, currentUrl, location) {
  if (!location)
    return { ok: false, reason: 'redirect without a Location header' };
  let origin;
  let next;
  try {
    origin = new URL(originUrl).origin;
    next = new URL(location, currentUrl);
  } catch {
    return { ok: false, reason: 'redirect target is not a valid URL' };
  }
  if (next.protocol !== 'https:')
    return { ok: false, reason: 'redirect left https' };
  if (next.origin !== origin)
    return { ok: false, reason: `redirect left ${origin}` };
  return { ok: true, url: next.toString() };
}

/**
 * Cooldown before the next upstream attempt after `failures` consecutive
 * failures. Zero while the feed is healthy.
 * @param {number} failures Consecutive failures (0 = none).
 * @returns {number} ms to wait before the next upstream attempt.
 */
export function nextTransitBackoffMs(failures) {
  const count = Number.isFinite(failures) ? Math.floor(failures) : 0;
  if (count <= 0) return 0;
  const index = Math.min(count, TRANSIT_BACKOFF_LADDER_MS.length) - 1;
  return TRANSIT_BACKOFF_LADDER_MS[index];
}

/**
 * Error thrown when a feed's shape is unusable rather than merely unavailable.
 * Carries `transitReason` so the middleware can answer honestly.
 */
export class TransitFeedShapeError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'TransitFeedShapeError';
    this.transitReason = reason;
  }
}

/**
 * Give every vehicle a best-available report time, and say WHERE it came from.
 *
 * A feed that omits `VehiclePosition.timestamp` is not reporting "now" — it is
 * reporting nothing, and treating the moment WE fetched as the moment the bus
 * was there is how a five-minute-old fix gets drawn as live. The ladder is
 * explicit instead: the vehicle's own timestamp, else the feed header's
 * timestamp (the operator's own statement about the snapshot), else fetch time,
 * which is labelled as a guess so the layer can age it conservatively.
 *
 * @param {object[]} vehicles Normalized vehicle records.
 * @param {number|null} headerTimestamp Feed header timestamp (epoch seconds).
 * @param {number} fetchedAtS Fetch time (epoch seconds).
 * @returns {object[]} Records with `timestamp` and `timestampSource` set.
 */
export function repairVehicleTimestamps(vehicles, headerTimestamp, fetchedAtS) {
  const header =
    Number.isFinite(headerTimestamp) && headerTimestamp > 0
      ? headerTimestamp
      : null;
  return (vehicles || []).map((vehicle) => {
    if (Number.isFinite(vehicle.timestamp) && vehicle.timestamp > 0) {
      return { ...vehicle, timestampSource: 'vehicle' };
    }
    if (header !== null)
      return { ...vehicle, timestamp: header, timestampSource: 'header' };
    return { ...vehicle, timestamp: fetchedAtS, timestampSource: 'fetch' };
  });
}

/**
 * Decode upstream bytes into the JSON snapshot the browser consumes.
 *
 * A DIFFERENTIAL feed is refused outright. Differential GTFS-Realtime carries
 * only what changed, so reading one as if it were a full snapshot would make
 * every unmentioned vehicle look like it had vanished. Deletion semantics are
 * not implemented, so the honest answer is to decline the feed, not to render
 * a wrong one.
 *
 * @param {object} feed Registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Raw GTFS-RT FeedMessage.
 * @param {number} [now=Date.now()] Fetch time (ms epoch).
 * @returns {{ feedId: string, name: string, fetchedAt: number, feedTimestamp: number|null,
 *   version: string|null, entityCount: number, truncated: boolean, count: number, vehicles: object[] }}
 */
export function buildTransitSnapshot(feed, bytes, now = Date.now()) {
  const decoded = decodeVehiclePositions(bytes);
  if (decoded.incrementality !== GTFS_INCREMENTALITY_FULL_DATASET) {
    throw new TransitFeedShapeError(
      `feed is differential (incrementality ${decoded.incrementality})`,
      'differential',
    );
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: decoded.timestamp,
    version: decoded.version,
    entityCount: decoded.entityCount,
    truncated: decoded.truncated,
    count: decoded.vehicles.length,
    vehicles: repairVehicleTimestamps(
      decoded.vehicles,
      decoded.timestamp,
      Math.floor(now / 1000),
    ),
  };
}

/**
 * Parse upstream JSON bytes, refusing anything that is not JSON.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {unknown}
 * @throws {TransitFeedShapeError}
 */
function parseNetworkJson(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(view));
  } catch {
    throw new TransitFeedShapeError('upstream is not JSON', 'not-json');
  }
}

/**
 * Decode a feed's route catalog into the JSON the layer draws.
 * An empty catalog is a fault, not an answer: no operator runs zero routes,
 * and caching "no routes" for twelve hours would blank the map for half a day.
 * @param {object} feed Registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Upstream body.
 * @param {number} [now=Date.now()]
 * @returns {object}
 */
export function buildTransitRoutesSnapshot(feed, bytes, now = Date.now()) {
  if (feed?.network?.routesFormat !== 'mbta-v3-route-patterns') {
    throw new TransitFeedShapeError('unsupported route format', 'format');
  }
  let normalized;
  try {
    normalized = normalizeMbtaRoutePatterns(parseNetworkJson(bytes), feed);
  } catch (error) {
    if (error instanceof TransitFeedShapeError) throw error;
    throw new TransitFeedShapeError(error?.message || 'bad routes', 'shape');
  }
  if (normalized.routes.length === 0) {
    throw new TransitFeedShapeError('route catalog is empty', 'empty');
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    count: normalized.routes.length,
    shapeCount: normalized.shapeCount,
    pointCount: normalized.pointCount,
    droppedShapes: normalized.droppedShapes,
    routes: normalized.routes,
  };
}

/**
 * Decode a feed's alert list into the JSON the layer reads. Zero alerts is a
 * legitimate answer (a quiet night) and is served as such.
 * @param {object} feed Registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Upstream body.
 * @param {number} [now=Date.now()]
 * @returns {object}
 */
export function buildTransitAlertsSnapshot(feed, bytes, now = Date.now()) {
  if (feed?.network?.alertsFormat !== 'gtfs-rt-alerts-json') {
    throw new TransitFeedShapeError('unsupported alerts format', 'format');
  }
  let normalized;
  try {
    normalized = normalizeGtfsRtAlertsJson(parseNetworkJson(bytes));
  } catch (error) {
    if (error instanceof TransitFeedShapeError) throw error;
    throw new TransitFeedShapeError(error?.message || 'bad alerts', 'shape');
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: normalized.feedTimestamp,
    truncated: normalized.truncated,
    count: normalized.alerts.length,
    alerts: normalized.alerts,
  };
}

/**
 * Classify a network-resource cache entry against its own policy windows.
 * @param {{ at: number }|null|undefined} entry
 * @param {number} now
 * @param {{ttlMs: number, staleMaxMs: number}} policy
 * @returns {'none'|'fresh'|'stale'|'expired'}
 */
export function transitNetworkCacheState(entry, now, policy) {
  if (!entry || !Number.isFinite(entry.at)) return 'none';
  const age = now - entry.at;
  if (age < policy.ttlMs) return 'fresh';
  if (age < policy.staleMaxMs) return 'stale';
  return 'expired';
}

/**
 * Response headers for a network resource.
 * @param {'HIT'|'MISS'|'INFLIGHT'|'STALE-ERROR'} cacheState
 * @param {{ttlMs: number}} policy
 * @param {string} [upstreamHost]
 * @returns {Record<string, string>}
 */
export function transitNetworkResponseHeaders(
  cacheState,
  policy,
  upstreamHost = '',
) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control':
      cacheState === 'STALE-ERROR'
        ? 'no-store'
        : `private, max-age=${Math.min(3600, Math.floor(policy.ttlMs / 1000))}`,
    'X-GEV-Cache': cacheState,
    'X-Content-Type-Options': 'nosniff',
    ...(upstreamHost ? { 'X-Transit-Upstream': upstreamHost } : {}),
  };
}

/**
 * Classify a cache entry for the request policy.
 * @param {{ at: number }|null|undefined} entry Cached snapshot (`at` = fetch ms).
 * @param {number} now
 * @returns {'none'|'fresh'|'stale'|'expired'}
 */
export function transitCacheState(entry, now) {
  if (!entry || !Number.isFinite(entry.at)) return 'none';
  const age = now - entry.at;
  if (age < 0) return 'fresh';
  if (age < TRANSIT_PROXY_TTL_MS) return 'fresh';
  if (age < TRANSIT_PROXY_STALE_MAX_MS) return 'stale';
  return 'expired';
}

/**
 * Response headers for a snapshot. `X-GEV-Cache` mirrors the other proxies
 * (HIT / MISS / INFLIGHT / STALE-ERROR) so the layer can surface staleness.
 * @param {'HIT'|'MISS'|'INFLIGHT'|'STALE-ERROR'} cacheState
 * @param {string} [upstreamHost]
 * @returns {Record<string, string>}
 */
export function transitResponseHeaders(
  cacheState,
  upstreamHost = '',
  contactedAt = null,
) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control':
      cacheState === 'STALE-ERROR'
        ? 'no-store'
        : `public, max-age=${Math.floor(TRANSIT_PROXY_TTL_MS / 1000)}`,
    'X-GEV-Cache': cacheState,
    ...(upstreamHost ? { 'X-Transit-Upstream': upstreamHost } : {}),
    // When the operator last ANSWERED, which is not when the body was fetched.
    // A feed whose file has not changed answers 304 forever, and the body we
    // keep serving carries its original fetch time; without this the browser
    // would read a healthy revalidated feed as one that had gone silent.
    ...(Number.isFinite(contactedAt)
      ? { 'X-Transit-Contact': String(Math.floor(contactedAt)) }
      : {}),
  };
}
