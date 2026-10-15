/**
 * Community-mapped OpenStreetMap speed camera locations (`highway=speed_camera`
 * nodes) fetched through the shared `/api/overpass` proxy. OSM data remains
 * ODbL, separate from the application code. These are mapped enforcement
 * device locations, not live detections or evidence of enforcement activity.
 */

export const LAYER_ID = 'speed-cameras';

/** Client endpoint of the repo-owned Overpass proxy (caching + abuse guards). */
export const OVERPASS_URL = '/api/overpass';

/** Pans settle before a query fires, so quick scrubbing issues no requests. */
export const REQUEST_DEBOUNCE_MS = 300;

/** Keep acquisition city-scale, never globe-wide (mirrors the ALPR viewport gate). */
export const MAX_VIEWPORT_DEGREES = 3;

/** Query boxes are snapped outward to this grid so nearby moves reuse one
 * accepted snapshot instead of re-querying the proxy on every pan. */
export const QUERY_SNAP_DEGREES = 0.05;

/** Element cap per query; reaching it reports limited coverage. */
export const QUERY_LIMIT = 1500;

/** Rendered camera cap: matches ALPR's order of magnitude for a city view. */
export const MAX_RENDERED = 1000;

/** Ambient label cohort for the shared overlay host. */
export const OVERLAY_COHORT_LIMIT = 96;
export const OVERLAY_COLLISION_CAPACITY = 48;

/** Vendor-neutral accent for cameras and their labels. */
export const SPEED_CAMERA_COLOR = '#ffb84d';
