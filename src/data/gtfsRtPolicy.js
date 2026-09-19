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
