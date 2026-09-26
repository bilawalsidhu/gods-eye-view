/**
 * Community-mapped OpenStreetMap ALPR locations, via hourly US/Canada detail
 * tiles. OSM data remains ODbL, separate from the application code. These are
 * mapped locations, not footage, plate records or evidence of current activity.
 */

export const LAYER_ID = 'alpr-cameras';

export const REQUEST_DEBOUNCE_MS = 500;

/** Keep camera acquisition city-scale, never globe-wide. */
export const MAX_VIEWPORT_DEGREES = 3;

/** Camera record cap; reaching it reports limited coverage. */
export const QUERY_LIMIT = 1500;

/** Render cap. Kept at or above QUERY_LIMIT on purpose: if it ever sat below
 * it, cameras between the two would be silently dropped while `saturated`
 * stayed false and `count` still reported them — a lie about coverage. */
export const MAX_RENDERED = 1500;

/** Meters — illustrative facing wedge depth, when a camera reports a bearing. */
export const DIRECTION_CONE_M = 90;
export const DIRECTION_CONE_HALF_ANGLE_DEG = 20;

export const EARTH_MEAN_RADIUS_M = 6371008.8;

/** Query boxes are snapped outward to this grid so nearby camera moves reuse
 * one accepted viewport snapshot rather than rebuilding records on every pan. */
export const QUERY_SNAP_DEGREES = 0.05;

/** A view still fully inside the last snapped query box reuses those records
 * for this long before selecting tiles again. */
export const QUERY_REUSE_MS = 10 * 60 * 1000;

/** Vendor-neutral camera badge palette, with coral selection. */
export const ALPR_COLOR = '#52d4ff';
export const ALPR_SELECTED_COLOR = '#ff6474';
export const MARKER_ICON_SIZE = 38;
export const SELECTED_MARKER_ICON_SIZE = 60;
export const MAX_CANVAS_FRUSTUMS = 64;

/** OSM attribution may collapse after five seconds; full credit stays in Data attribution. */
export const CREDIT_DISPLAY_MS = 5000;
