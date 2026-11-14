/**
 * @module railProxy
 * @description Pure server-side mechanics for the `/api/rail` proxy.
 *
 * The upstream mechanics are the Transit proxy's (src/data/transitProxy.js):
 * the same decoder, timestamp repair, redirect rule, conditional headers, cache
 * windows and backoff ladder. What differs is which feeds are reachable and
 * what leaves the server: only vehicles a feed's classifier recognises as
 * trains, each tagged with its category, mode and position source. On top of
 * that come the Irish Rail XML and SIRI-VM adapters and trip updates. Every
 * train is placed where its operator reports it. Every feed is open: no
 * request carries a credential.
 */

import {
  TRANSIT_ADMISSION_MAX_GLOBAL,
  TRANSIT_PROXY_MAX_BODY_BYTES,
  TRANSIT_PROXY_STALE_MAX_MS,
  TRANSIT_PROXY_TTL_MS,
  TransitFeedShapeError,
  buildTransitSnapshot,
} from './transitProxy.js';
import { GTFS_INCREMENTALITY_FULL_DATASET } from './gtfsRealtime.js';
import {
  RAIL_FEED_REGISTRY,
  classifyTrain,
  getRailFeed,
  railFeedHasTripUpdates,
  railFeedPositions,
} from './railFeeds.js';
import { decodeIrishRailTrains } from './irishRail.js';
import { decodeSiriVehicleMonitoring } from './railSiriVm.js';
import { decodeTripUpdates } from './railTripUpdates.js';
import { isNoTrainPositionPoint } from './railNoPositions.js';

/**
 * Text formats with their own adapter, by registry `format`. Each turns the
 * document and the fetch time (epoch s) into `{entityCount, truncated,
 * vehicles, feedTimestamp?}`.
 */
const TEXT_ADAPTERS = Object.freeze({
  'irish-rail-xml': decodeIrishRailTrains,
  'siri-vm': decodeSiriVehicleMonitoring,
});

export {
  TRANSIT_ADMISSION_MAX_PER_FEED as RAIL_ADMISSION_MAX_PER_FEED,
  TRANSIT_ADMISSION_WINDOW_MS as RAIL_ADMISSION_WINDOW_MS,
  TRANSIT_PROXY_TIMEOUT_MS as RAIL_PROXY_TIMEOUT_MS,
  TransitFeedShapeError as RailFeedShapeError,
  isAcceptableTransitUpstreamUrl as isAcceptableRailUpstreamUrl,
  nextTransitBackoffMs as nextRailBackoffMs,
} from './transitProxy.js';

/**
 * Largest path or schedule pack the proxy serves or reads (bytes). The
 * biggest national packs built so far were 14 to 16 MB; anything far beyond
 * that is a build fault, not a pack to ship. A pack over the cap is refused
 * with its own answer, not taken for a missing one.
 */
export const RAIL_PATH_PACK_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Default freshness window for trip updates. Predictions move more slowly
 * than positions, and several operators refresh them every 30 to 60 s.
 */
export const RAIL_TRIP_UPDATES_TTL_MS = 30_000;
/** Shortest window a registry entry may ask for. */
export const RAIL_MIN_TTL_MS = 5_000;
/** Trips one `/updates` answer carries, after the rail filter. */
export const RAIL_UPDATES_MAX_TRIPS = 3_000;
/** Stop updates one `/updates` answer carries, across all its trips. */
export const RAIL_UPDATES_MAX_STOPS = 40_000;

/**
 * Freshness window for one route of a feed: its own interval when the
 * registry sets one (never below RAIL_MIN_TTL_MS), else the default.
 * @param {object} feed
 * @param {'trains'|'updates'} route
 * @returns {number} ms
 */
export function railFeedTtlMs(feed, route = 'trains') {
  const own =
    route === 'updates' ? feed?.tripUpdatesIntervalMs : feed?.pollIntervalMs;
  if (Number.isFinite(own) && own > 0) return Math.max(RAIL_MIN_TTL_MS, own);
  return route === 'updates' ? RAIL_TRIP_UPDATES_TTL_MS : TRANSIT_PROXY_TTL_MS;
}

/**
 * Largest byte cap a feed may set for itself (`maxBodyBytes`): nothing
 * larger is read into memory.
 */
export const RAIL_PROXY_MAX_BODY_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * Upstream byte cap for a feed: its own cap when it sets one (never above
 * RAIL_PROXY_MAX_BODY_CEILING_BYTES), else the Transit proxy's 8 MiB.
 * @param {object} feed
 * @returns {number}
 */
export function railMaxBodyBytes(feed) {
  const own = feed?.maxBodyBytes;
  return Number.isFinite(own) && own > 0
    ? Math.min(own, RAIL_PROXY_MAX_BODY_CEILING_BYTES)
    : TRANSIT_PROXY_MAX_BODY_BYTES;
}

/**
 * Classify a cache entry against a freshness window: the Transit policy with
 * a per-feed TTL. The serve-stale window is the same ten minutes.
 * @param {{at: number}|null|undefined} entry
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {'none'|'fresh'|'stale'|'expired'}
 */
export function railCacheStateFor(entry, now, ttlMs = TRANSIT_PROXY_TTL_MS) {
  if (!entry || !Number.isFinite(entry.at)) return 'none';
  const age = now - entry.at;
  if (age < ttlMs) return 'fresh';
  if (age < Math.max(TRANSIT_PROXY_STALE_MAX_MS, ttlMs)) return 'stale';
  return 'expired';
}

/**
 * Resolve `/trains/<feedId>`, `/paths/<feedId>`, `/schedule/<feedId>` or
 * `/updates/<feedId>` (the path after the `/api/rail` mount) to a pollable
 * feed. Anything else (another route, an unknown or disabled id, an
 * `/updates` request for a feed with no trip updates, path tricks) resolves
 * to null and the caller 404s.
 * @param {string} url Request URL relative to the mount point.
 * @returns {{ route: 'feeds' } |
 *   { route: 'trains'|'paths'|'schedule'|'updates', feed: object } | null}
 */
export function resolveRailRoute(url) {
  const pathname = String(url || '').split('?')[0];
  if (pathname === '/feeds' || pathname === '/feeds/')
    return { route: 'feeds' };
  const match = /^\/(trains|paths|schedule|updates)\/([^/]+)\/?$/.exec(
    pathname,
  );
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const feed = getRailFeed(id);
  if (!feed) return null;
  if (match[1] === 'updates' && !railFeedHasTripUpdates(feed)) return null;
  return { route: match[1], feed };
}

/**
 * Classify decoded vehicles and keep only trains. A position where no train
 * is placed (src/data/railNoPositions.js: Ukraine) is dropped first, so it
 * is only counted and never leaves the server.
 */
function keepTrains(feed, vehicles, routeFor = null) {
  const positionSource = railFeedPositions(feed) === 'event' ? 'event' : 'gps';
  const trains = [];
  for (const vehicle of vehicles) {
    if (isNoTrainPositionPoint(vehicle.lat, vehicle.lon)) continue;
    const routeId = resolvedRouteId(feed, vehicle, routeFor);
    const kind = classifyTrain(feed, routeId, { tripId: vehicle.tripId });
    if (!kind) continue;
    trains.push({
      ...vehicle,
      routeId,
      category: kind.category,
      mode: kind.mode,
      ...(kind.tourist ? { tourist: true } : {}),
      positionSource,
    });
  }
  return trains;
}

/**
 * The route a record is classified by. A feed with `routesFrom: 'schedule'`
 * publishes trips whose route is missing or not the one its classifier reads;
 * `routeFor(tripId)` answers from the feed's schedule pack, whose route ids
 * the build wrote to carry the product. A trip the pack does not know keeps
 * what the feed said, which its classifier then drops.
 */
function resolvedRouteId(feed, record, routeFor) {
  if (feed?.routesFrom !== 'schedule' || typeof routeFor !== 'function')
    return record.routeId;
  return (record.tripId && routeFor(record.tripId)) || record.routeId;
}

/**
 * For a feed whose positions name each train by its number
 * (`positionsByTrainNumber`, Irish Rail's train codes), the record takes
 * the schedule pack's trip that number is running now (`tripFor`, given the
 * number and the record, whose stated delay moves its timetable), so the
 * train is drawn on its line and its card lists its stops; the number stays
 * as `trainNumber`. A number the timetable does not place keeps its own id.
 */
function byTrainNumber(feed, vehicles, tripFor) {
  if (feed?.positionsByTrainNumber !== true || typeof tripFor !== 'function')
    return vehicles;
  return vehicles.map((vehicle) => {
    const tripId = vehicle.tripId ? tripFor(vehicle.tripId, vehicle) : null;
    return tripId
      ? { ...vehicle, tripId, trainNumber: vehicle.tripId }
      : vehicle;
  });
}

/**
 * For a feed whose header clock cannot be trusted (`headerClock:
 * 'untrusted'`, Renfe: local time written as UTC), a time the Transit
 * ladder took from the header is replaced by the fetch time and labelled so.
 */
function distrustHeaderClock(feed, vehicles, now) {
  if (feed?.headerClock !== 'untrusted') return vehicles;
  const fetchedS = Math.floor(now / 1000);
  return vehicles.map((vehicle) =>
    vehicle.timestampSource === 'header'
      ? { ...vehicle, timestamp: fetchedS, timestampSource: 'fetch' }
      : vehicle,
  );
}

/**
 * An upstream answer that is no document of the feed's: a failed fetch, not
 * a reason to distrust the last good snapshot, which the service keeps
 * serving while it is young enough (`code: 'UPSTREAM_UNREADABLE'`, a 502).
 * @param {string} detail
 * @returns {Error & {code: string}}
 */
function unreadableUpstream(detail) {
  const failure = new Error(`upstream document unreadable: ${detail}`);
  failure.code = 'UPSTREAM_UNREADABLE';
  return failure;
}

/**
 * Run a GTFS-RT decode and refuse what is not a FeedMessage: bytes protobuf
 * cannot read (an HTML or JSON error page served as 200), and a message
 * without a FeedHeader or its gtfs_realtime_version, which every
 * FeedMessage carries. An empty body (a 200 or 204 with nothing in it)
 * decodes to exactly that, and would otherwise read as a full snapshot with
 * no trains. A DIFFERENTIAL feed's refusal passes through as it is.
 * @template {{version: string|null}} T
 * @param {() => T} decode
 * @returns {T}
 */
function decodeGtfsRealtime(decode) {
  let decoded;
  try {
    decoded = decode();
  } catch (error) {
    if (error instanceof TransitFeedShapeError) throw error;
    throw unreadableUpstream(error?.message || String(error));
  }
  if (decoded?.version === null || decoded?.version === undefined)
    throw unreadableUpstream('no FeedHeader with a gtfs_realtime_version');
  return decoded;
}

/**
 * Decode upstream bytes into the JSON snapshot the Rail layer consumes.
 *
 * For GTFS-RT feeds, decoding, the refusal of DIFFERENTIAL feeds and the
 * report-time ladder are the Transit proxy's; a body that is no FeedMessage
 * (no header, no version, not protobuf) is refused as unreadable
 * (decodeGtfsRealtime). Irish Rail's XML and SIRI-VM go through their
 * adapters. The classifier then runs on every vehicle: a vehicle it does
 * not recognise (a bus in a mixed feed, a shuttle, an out-of-service vehicle
 * with no route in a mixed feed) is dropped and only counted, so the browser
 * receives trains and nothing else. Every train carries `positionSource`:
 * `gps` for GTFS-RT positions, `event` for signalling events.
 *
 * @param {object} feed Rail registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Raw upstream body.
 * @param {number} [now=Date.now()] Fetch time (ms epoch).
 * @param {{routeFor?: Function|null, tripFor?: Function|null}} [lookups]
 *   `routeFor` resolves a trip's route from the schedule pack, and
 *   `tripFor(number, record)` a train number's running trip
 *   (`positionsByTrainNumber`).
 * @returns {{ feedId: string, name: string, fetchedAt: number, feedTimestamp: number|null,
 *   version: string|null, entityCount: number, truncated: boolean, count: number,
 *   dropped: number, positions: string, trains: object[] }}
 */
export function buildRailSnapshot(
  feed,
  bytes,
  now = Date.now(),
  { routeFor = null, tripFor = null } = {},
) {
  const adapter = Object.hasOwn(TEXT_ADAPTERS, feed?.format)
    ? TEXT_ADAPTERS[feed.format]
    : null;
  if (adapter) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const text = new TextDecoder('utf-8').decode(view);
    let decoded;
    try {
      decoded = adapter(text, Math.floor(now / 1000));
    } catch (error) {
      // An unreadable document (an error page served as 200, a truncated
      // body) is a failed fetch, not a reason to distrust the last good one.
      throw unreadableUpstream(error?.message || String(error));
    }
    const trains = keepTrains(
      feed,
      byTrainNumber(feed, decoded.vehicles, tripFor),
      routeFor,
    );
    return {
      feedId: feed.id,
      name: feed.name,
      fetchedAt: now,
      feedTimestamp: Number.isFinite(decoded.feedTimestamp)
        ? decoded.feedTimestamp
        : null,
      version: null,
      entityCount: decoded.entityCount,
      truncated: decoded.truncated,
      count: trains.length,
      dropped: decoded.vehicles.length - trains.length,
      positions: railFeedPositions(feed),
      trains,
    };
  }
  const decoded = decodeGtfsRealtime(() =>
    buildTransitSnapshot(feed, bytes, now),
  );
  const trains = keepTrains(
    feed,
    distrustHeaderClock(feed, decoded.vehicles, now),
    routeFor,
  );
  return {
    feedId: decoded.feedId,
    name: decoded.name,
    fetchedAt: decoded.fetchedAt,
    feedTimestamp:
      feed.headerClock === 'untrusted' ? null : decoded.feedTimestamp,
    version: decoded.version,
    entityCount: decoded.entityCount,
    truncated: decoded.truncated,
    count: trains.length,
    dropped: decoded.vehicles.length - trains.length,
    positions: railFeedPositions(feed),
    trains,
  };
}

/**
 * Decode a TripUpdates feed into the `/api/rail/updates/<feedId>` body: one
 * record per rail trip, filtered with the same classifier as the positions
 * (a feed's buses never leave the server), capped in trips and stops.
 *
 * A DIFFERENTIAL feed is refused, for the same reason positions are: an
 * unmentioned trip would read as one with no prediction. A body that is no
 * FeedMessage is refused as unreadable (decodeGtfsRealtime).
 *
 * @param {object} feed Rail registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Raw GTFS-RT FeedMessage.
 * @param {number} [now=Date.now()] Fetch time (ms epoch).
 * @param {{routeFor?: ((tripId: string) => string|null)|null}} [lookups]
 *   `routeFor` is the schedule pack's trip-to-route lookup, for a feed
 *   whose trips do not carry the route its classifier reads (`routesFrom:
 *   'schedule'`).
 * @returns {{ feedId: string, name: string, fetchedAt: number,
 *   feedTimestamp: number|null, entityCount: number, truncated: boolean,
 *   count: number, dropped: number, trips: object[] }}
 */
export function buildRailTripUpdatesSnapshot(
  feed,
  bytes,
  now = Date.now(),
  { routeFor = null } = {},
) {
  const decoded = decodeGtfsRealtime(() => decodeTripUpdates(bytes));
  if (decoded.incrementality !== GTFS_INCREMENTALITY_FULL_DATASET) {
    throw new TransitFeedShapeError(
      `feed is differential (incrementality ${decoded.incrementality})`,
      'differential',
    );
  }
  const trips = [];
  let truncated = decoded.truncated;
  let stops = 0;
  let rail = 0;
  for (const trip of decoded.trips) {
    const routeId = resolvedRouteId(feed, trip, routeFor);
    const kind = classifyTrain(feed, routeId, { tripId: trip.tripId });
    if (!kind) continue;
    rail += 1;
    if (
      trips.length >= RAIL_UPDATES_MAX_TRIPS ||
      stops + trip.stops.length > RAIL_UPDATES_MAX_STOPS
    ) {
      truncated = true;
      continue;
    }
    stops += trip.stops.length;
    trips.push({
      ...trip,
      routeId,
      category: kind.category,
      mode: kind.mode,
      ...(kind.tourist ? { tourist: true } : {}),
    });
  }
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: decoded.timestamp,
    entityCount: decoded.entityCount,
    truncated,
    count: trips.length,
    dropped: decoded.trips.length - rail,
    trips,
  };
}

/**
 * Upstream request headers. Same obligations as Transit's (conditional
 * validators, gzip, a User-Agent that says who is asking, any identify-yourself
 * header the registry names), with this proxy's own name in the User-Agent.
 * A feed's own `headers` (an Accept for an XML feed) come last.
 * @param {object} feed Registry entry.
 * @param {{etag?: string|null, lastModified?: string|null}} [validators]
 * @returns {Record<string, string>}
 */
export function railUpstreamHeaders(feed, validators = null) {
  return {
    'User-Agent':
      'gods-eye-view-rail-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
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
 * Upstream requests one minute may need when every feed in the registry is
 * polled at once: one per freshness window for each feed's positions and
 * trip updates.
 * @param {ReadonlyArray<object>} [feeds]
 * @returns {number}
 */
export function railNaturalRequestsPerMinute(feeds = RAIL_FEED_REGISTRY) {
  let total = 0;
  for (const feed of feeds) {
    if (feed?.defaultEnabled !== true) continue;
    if (feed.url) total += Math.ceil(60_000 / railFeedTtlMs(feed, 'trains'));
    if (railFeedHasTripUpdates(feed))
      total += Math.ceil(60_000 / railFeedTtlMs(feed, 'updates'));
  }
  return total;
}

/**
 * The process-wide admission cap (requests per admission window, all
 * operators): the natural load of every enabled feed, half again on top for
 * retries on the backoff ladder, never below the Transit proxy's own cap
 * (TRANSIT_ADMISSION_MAX_GLOBAL, 40). It is a backstop against a bug or a
 * runaway client, not the protection an operator relies on: that is each
 * feed's freshness window and the per-feed admission count. Transit's fixed
 * cap alone sat below the natural load once the registry passed about ten
 * feeds polled every 15 s, so a viewer of several regions got 503s from a
 * healthy proxy.
 * @param {ReadonlyArray<object>} [feeds]
 * @returns {number}
 */
export function railAdmissionGlobalMax(feeds = RAIL_FEED_REGISTRY) {
  return Math.max(
    TRANSIT_ADMISSION_MAX_GLOBAL,
    Math.ceil(railNaturalRequestsPerMinute(feeds) * 1.5),
  );
}

/**
 * Response headers for a snapshot. `X-GEV-Cache` mirrors the other proxies
 * (HIT / MISS / INFLIGHT / STALE-ERROR); `X-Rail-Contact` is when the operator
 * last ANSWERED, which a revalidated (304) feed advances without changing the
 * body's own fetch time. `max-age` is what is left of the feed's own
 * freshness window once the snapshot is `ageMs` old, so a HIT near the end
 * of the window is not kept a whole window more downstream.
 * @param {'HIT'|'MISS'|'INFLIGHT'|'STALE-ERROR'} cacheState
 * @param {string} [upstreamHost]
 * @param {number|null} [contactedAt]
 * @param {number} [ttlMs]
 * @param {number} [ageMs] How old the snapshot is (ms); 0 for a fresh one.
 * @returns {Record<string, string>}
 */
export function railResponseHeaders(
  cacheState,
  upstreamHost = '',
  contactedAt = null,
  ttlMs = TRANSIT_PROXY_TTL_MS,
  ageMs = 0,
) {
  const age = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0;
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control':
      cacheState === 'STALE-ERROR'
        ? 'no-store'
        : `public, max-age=${Math.max(0, Math.ceil((ttlMs - age) / 1000))}`,
    'X-GEV-Cache': cacheState,
    ...(upstreamHost ? { 'X-Rail-Upstream': upstreamHost } : {}),
    ...(Number.isFinite(contactedAt)
      ? { 'X-Rail-Contact': String(Math.floor(contactedAt)) }
      : {}),
  };
}
