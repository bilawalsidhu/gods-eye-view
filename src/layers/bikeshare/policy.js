/**
 * A portable export (package.json): no i18n here. The label stays English
 * data; the Layers panel shows it translated.
 */
const msg = (text) => text;

/**
 * The Bike Share row's own description of what it shows. The row shows this,
 * so the merged coverage is stated rather than implied: the city GBFS
 * networks, each with live availability per station rather than per bike.
 */
export const BIKESHARE_DESCRIPTION = msg(
  'City docked bike share — live availability per station, not per bike',
);

export const BIKESHARE_SELECTED_OVERLAY_SOURCE_ID = 'bikeshare-selected';

export const BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

// --- Activation / display thresholds ---
/** Altitude (m) at which bikeshare layer becomes eligible for display. */

const ACTIVATION_ALTITUDE_M = 50000;

/** Hysteresis enter threshold — layer activates when camera drops below this. */

export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 2000;

/** Hysteresis exit threshold — layer deactivates when camera rises above this. */

export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 2000;

/** Debounce interval (ms) for camera-change proximity checks. */

export const CAMERA_DEBOUNCE_MS = 340;

/**
 * How far the view moves before the camera tells the layer (the camera's
 * `changed` threshold): fine, so it notices entering a city's range.
 */

export const CAMERA_CHANGED_THRESHOLD = 0.05;

/** Default radius (km) for determining whether a city is in camera range. */

export const CITY_RANGE_BASE_KM = 100;

/** Polling interval (ms) for refreshing station status data. */

export const STATUS_POLL_MS = 60000;

// --- Point rendering constants ---
/** Minimum rendered point size in pixels. */

export const POINT_SIZE_MIN = 4;

/** Maximum rendered point size in pixels. */

export const POINT_SIZE_MAX = 12;

/** Fallback station capacity when real data is unavailable. */

export const DEFAULT_CAPACITY = 15;

/** Vertical offset (m) above terrain for station points. */

export const POINT_HEIGHT_OFFSET_M = 2.0;

/** Hard cap on total rendered station points across all cities. */

export const MAX_TOTAL_POINTS = 8000;

// --- Availability color palette ---
// Renderer colours, `[r, g, b, a]` in 0..1: the CSS colours below at the
// alphas the points draw them with.

/** A CSS `#rrggbb` colour at `alpha`, as a renderer colour. */
const hex = (css, alpha) =>
  Object.freeze([
    parseInt(css.slice(1, 3), 16) / 255,
    parseInt(css.slice(3, 5), 16) / 255,
    parseInt(css.slice(5, 7), 16) / 255,
    alpha,
  ]);

/** Station has >60% bikes available. */

export const COLOR_GREEN = hex('#00ff88', 0.95);

/** Station has 30-60% bikes available. */

export const COLOR_YELLOW = hex('#ffaa00', 0.94);

/** Station has <30% bikes available. */

export const COLOR_RED = hex('#ff4444', 0.94);

/** No status data available for station. */

export const COLOR_NEUTRAL = hex('#91a4b4', 0.62);

/** Station is offline (not installed, not renting, or not returning). */

export const COLOR_MUTED = hex('#687581', 0.48);

/** Outline color for all station points. */

export const COLOR_OUTLINE = Object.freeze([0, 0, 0, 0.25]);

// --- Selected-station highlight ---

/** The selected station's dot: cyan, outlined black, drawn over everything. */

export const SELECTED_POINT_STYLE = Object.freeze({
  pixelSize: 14,
  color: Object.freeze([0, 1, 1, 1]),
  outlineColor: Object.freeze([0, 0, 0, 1]),
  outlineWidth: 2,
  disableDepthTest: Number.POSITIVE_INFINITY,
});

// --- Station dot distance falloff ---

/** Station dots grow near the eye and shrink far from it. */

export const POINT_SCALE_BY_DISTANCE = Object.freeze({
  near: 200,
  nearValue: 1.35,
  far: 130000,
  farValue: 0.4,
});

/** Station dots fade out with distance. */

export const POINT_FADE_BY_DISTANCE = Object.freeze({
  near: 200,
  nearValue: 1.0,
  far: 180000,
  farValue: 0.15,
});

/** Station dots draw over the ground within this many metres of the eye. */

export const POINT_DISABLE_DEPTH_TEST_M = 2500;

/**
 * The availability ramp as DATA, so the row legend and the map points are
 * classified by the same function and cannot drift apart.
 *
 * Each band names the availability range it covers, the colour the point is
 * drawn in and the plain-language label the row shows. The ramp is the one
 * the layer has always used: more than 60% of the docks hold a bike (green),
 * 30-60% (yellow), under 30% (red), a station with no status (neutral), and a
 * station that is not renting or returning (muted).
 *
 * The colours are the CSS hex forms of COLOR_GREEN / COLOR_YELLOW / COLOR_RED
 * / COLOR_NEUTRAL / COLOR_MUTED: the legend paints a CSS swatch, the point
 * paints a Cesium colour, and they have to be the same colour.
 */
export const BIKESHARE_AVAILABILITY_BANDS = Object.freeze([
  Object.freeze({
    id: 'plenty',
    label: msg('Over 60% bikes'),
    color: '#00ff88',
  }),
  Object.freeze({
    id: 'some',
    label: msg('30-60% bikes'),
    color: '#ffaa00',
  }),
  Object.freeze({
    id: 'few',
    label: msg('Under 30% bikes'),
    color: '#ff4444',
  }),
  Object.freeze({
    id: 'offline',
    label: msg('Not renting or returning'),
    color: '#687581',
  }),
  Object.freeze({
    id: 'unknown',
    label: msg('No status yet'),
    color: '#91a4b4',
  }),
]);

/**
 * The availability band a station's status falls in.
 *
 * This is the ONE classification: the renderer colours a point from it and
 * the row legend counts from it, so a station's colour and the band that
 * counts it can never disagree.
 *
 * @param {object|null} status The station status record.
 * @param {number} capacity The resolved dock capacity.
 * @returns {string} A BIKESHARE_AVAILABILITY_BANDS id.
 */
export function bikeshareAvailabilityBand(status, capacity) {
  if (!status) return 'unknown';
  if (!status.isInstalled || !status.isRenting || !status.isReturning)
    return 'offline';
  // An UNKNOWN count is not zero: a feed that does not publish the number
  // leaves it null, and null must stay unknown rather than reading as an
  // empty station. Only a reported zero is empty.
  const raw = status.bikesAvailable;
  if (raw === null || raw === undefined || raw === '') return 'unknown';
  const bikes = Number(raw);
  if (!Number.isFinite(bikes)) return 'unknown';
  const cap = Math.max(1, Number(capacity) || DEFAULT_CAPACITY);
  const ratio = bikes / cap;
  if (ratio > 0.6) return 'plenty';
  if (ratio >= 0.3) return 'some';
  return 'few';
}
