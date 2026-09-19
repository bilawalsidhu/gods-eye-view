/**
 * GTFS-RT feed registry + proxy policy — worker-safe.
 *
 * Shared by the dev middleware (`vite/proxies/gtfsrt.js`) and the Cloudflare
 * Pages Function (`functions/api/gtfsrt/[[path]].js`). Both runtimes import
 * from this module so they cannot drift on the allowlist, cache-control, or
 * body-cap. No `node:*`, `fs`, `Buffer`, or `process` references here —
 * workerd has none of those.
 */

/**
 * Known keyless GTFS-RT feeds. Each entry is an HTTPS VehiclePositions.pb
 * feed the app fetches without credentials. Names follow the transit agency
 * so the in-app attribution and data credit are readable:
 *
 *   mbta           — Boston (MBTA). Real-time bus + heavy rail + commuter rail.
 *                    406+ vehicles per snapshot, 47 KB. Refresh every ~10s.
 *   ovapi          — Netherlands nationwide (OVapi). Bus, tram, metro, ferry.
 *                    Variable load. Refresh ~30s.
 *   metro-mn       — Twin Cities (Metro Transit). Bus + light rail. Refresh ~30s.
 *
 * Adding a feed requires: (1) entry below, (2) `dataCredits.js` entry, (3)
 * one unit test that captures a sample of the feed's bytes through
 * `isAllowedGtfsRtFeed()` and pins its response size under
 * GTFSRT_MAX_BODY_BYTES.
 * @type {{[feedId: string]: string}}
 */
export const GTFS_RT_FEEDS = Object.freeze({
  'mbta':     'https://cdn.mbta.com/realtime/VehiclePositions.pb',
  'ovapi':    'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
  'metro-mn': 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
});

/**
 * Approximate service-area bounding boxes for each GTFS-RT feed
 * ({south, west, north, east} in degrees). Used by `syntheticTraffic.js`
 * to decide when to spawn the TomTom-flow fallback vehicles: if the camera
 * viewport (or the per-tile bounds) is covered by ANY feed's service area,
 * the real feed is presumably the source of truth and synthetics stay
 * silent there.
 *
 * Boxes are intentional looseness (≈ 30–60 km slack on each side) rather
 * than exact transit authority boundaries: the cost of a missed real feed
 * is high (we'd show synthetic cars where buses actually are), so we'd
 * rather miss a synthetic opportunity at the fringe. These are not
 * authoritative — they are "where this feed is plausibly the real source".
 *
 *   mbta     — Greater Boston / MBTA commuter rail reach.
 *              Real feed spans MBTA bus + subway + commuter rail lines.
 *   ovapi    — Netherlands nationwide (island of Bonaire excluded).
 *   metro-mn — Twin Cities + suburbs.
 * @type {{[feedId: string]: {south: number, west: number, north: number, east: number}}}
 */
export const GTFS_RT_SERVICE_BBOXES = Object.freeze({
  'mbta':     { south: 41.6,  west: -71.7, north: 42.7,   east: -70.6  },
  'ovapi':    { south: 50.7,  west:   3.4, north: 53.5,   east:   7.3  },
  'metro-mn': { south: 44.5,  west: -94.0, north: 45.5,   east: -92.5  },
});

/** Public set of feed IDs the client may name. */
export const GTFS_RT_FEED_IDS = Object.freeze(Object.keys(GTFS_RT_FEEDS));

/** Maximum body size (bytes) the proxy will relay. 2 MB is ~40× the largest
 * known feed; the cap exists to refuse a runaway upstream. */
export const GTFSRT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Per-request timeout (ms). MBTA p99 is <3s on a healthy day; 8s leaves
 * headroom for a cold cache without blocking the layer's 30s tick. */
export const GTFSRT_PROXY_TIMEOUT_MS = 8000;

/** Cache-Control header value emitted by the proxy. The feeds update faster
 * than this TTL, but the browser conditional GET keeps the wire quiet. */
export const GTFS_RT_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=20';

/**
 * Resolve a feed ID to its upstream URL, or null when the ID is unknown.
 * Returning null (vs throwing) keeps both runtimes' bad-feed paths symmetric:
 * a single `if (!target)` check after the lookup.
 * @param {string} feedId - URL-segment feed identifier.
 * @returns {string|null} Absolute upstream URL, or null when not allowlisted.
 */
export function isAllowedGtfsRtFeed(feedId) {
  if (typeof feedId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(GTFS_RT_FEEDS, feedId)
    ? GTFS_RT_FEEDS[feedId]
    : null;
}

/**
 * Build the Cache-Control response header for a relayed GTFS-RT body.
 * Centralized so any future change (e.g. a per-feed TTL) lands in one place
 * and both runtimes pick it up.
 * @returns {string} The exact header value to set on relay responses.
 */
export function gtfsRtCacheControl() {
  return GTFS_RT_CACHE_CONTROL;
}

/**
 * Does the named feed's service-area box cover the given rect? Pure
 * degrees-vs-degrees — no dependency on Cesium — so it's safe for both
 * the layer module (client) and any potential runtime-side filter.
 *
 * "Covers" here means intersection in BOTH axes (south<north, west<east);
 * a feed whose box is disjoint is "not relevant" for the rect. The bbox
 * entries are pre-validated by construction (south<north, west<east).
 *
 * @param {string} feedId - Feed id (`mbta`, `ovapi`, `metro-mn`).
 * @param {{south: number, west: number, north: number, east: number}} rect - Target rectangle, degrees.
 * @returns {boolean} True iff the feed's service area intersects the rect.
 */
export function gtfsRtFeedCoversRect(feedId, rect) {
  if (!rect || !Number.isFinite(rect.south) || !Number.isFinite(rect.west)
      || !Number.isFinite(rect.north) || !Number.isFinite(rect.east)) return false;
  const box = GTFS_RT_SERVICE_BBOXES[feedId];
  if (!box) return false;
  if (rect.east <= rect.west || rect.north <= rect.south) return false;
  if (rect.east <= box.west || box.east <= rect.west) return false;
  if (rect.north <= box.south || box.north <= rect.south) return false;
  return true;
}

/**
 * True if ANY registered GTFS-RT feed's service area intersects the
 * given rect. Used by `syntheticTraffic.js` to short-circuit
 * ("no need to spawn fallback vehicles in Boston — the MBTA feed is the
 * real source of truth here").
 *
 * @param {{south: number, west: number, north: number, east: number}} rect - Target rectangle, degrees.
 * @returns {boolean} True if at least one feed covers the rect.
 */
export function gtfsRtAnyFeedCoversRect(rect) {
  if (!rect) return false;
  for (const feedId of GTFS_RT_FEED_IDS) {
    if (gtfsRtFeedCoversRect(feedId, rect)) return true;
  }
  return false;
}
