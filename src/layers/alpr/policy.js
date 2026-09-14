/**
 * @file Community-mapped automatic license plate reader (ALPR) camera layer.
 *
 * Data source: OpenStreetMap contributors, including the DeFlock community
 * (`man_made=surveillance` + `surveillance:type=ALPR`) — see
 * https://wiki.openstreetmap.org/wiki/Tag:surveillance:type=ALPR and
 * https://deflock.org. OSM data remains ODbL 1.0, separate from the MIT code.
 * Fetched viewport-bounded through the existing generic
 * `/api/overpass` proxy (same one `traffic.js` and `militaryInstallations.js`
 * use) — no new server route needed for a single narrow tag pair.
 *
 * This is mapped surveillance infrastructure, not a live camera feed: no
 * plate records, no vendor accounts, nothing beyond what a contributor chose
 * to publish to OSM. Coverage and tag accuracy are not guaranteed.
 *
 * @module data/alprCameras
 */

export const LAYER_ID = 'alpr-cameras';

export const OVERPASS_URL = '/api/overpass';

export const REQUEST_DEBOUNCE_MS = 500;

/** Keep public Overpass queries city-scale, never globe-wide. */
export const MAX_VIEWPORT_DEGREES = 3;

/** Overpass `out body N;` cap — also detects possibly truncated coverage. */
export const QUERY_LIMIT = 1500;

/** Render cap. Kept at or above QUERY_LIMIT on purpose: if it ever sat below
 * it, cameras between the two would be silently dropped while `saturated`
 * stayed false and `count` still reported them — a lie about coverage. */
export const MAX_RENDERED = 1500;

/** Meters — length of the facing-direction indicator line, when a camera reports one. */
export const DIRECTION_CONE_M = 25;

export const EARTH_MEAN_RADIUS_M = 6371008.8;

/** Query boxes are snapped outward to this grid so nearby camera moves reuse
 * one Overpass request body (the shared proxy keys its cache and in-flight
 * dedupe by the exact body) instead of each becoming a distinct upstream fetch. */
export const QUERY_SNAP_DEGREES = 0.05;

/** A view still fully inside the last snapped query box reuses those records
 * for this long before asking Overpass again. */
export const QUERY_REUSE_MS = 10 * 60 * 1000;

/** One vendor-neutral color, distinct from CCTV's cyan markers. */
export const ALPR_COLOR = '#c084fc';

/** OSM attribution may collapse after five seconds; full credit stays in Data attribution. */
export const CREDIT_DISPLAY_MS = 5000;
