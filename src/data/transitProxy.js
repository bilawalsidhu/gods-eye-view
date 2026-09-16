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
 * Resolve `/vehicles/<feedId>` (the path after the `/api/transit` mount) to a
 * registered feed. Anything else — a different route, an unknown id, path
 * tricks, a query string — resolves to null and the caller 404s.
 * @param {string} url Request URL relative to the mount point.
 * @returns {{ route: 'feeds' } | { route: 'vehicles', feed: object } | null}
 */
export function resolveTransitRoute(url) {
  const pathname = String(url || '').split('?')[0];
  if (pathname === '/feeds' || pathname === '/feeds/')
    return { route: 'feeds' };
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
export function transitUpstreamHeaders(feed, validators = null) {
  return {
    'User-Agent':
      'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    Accept: 'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1',
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
