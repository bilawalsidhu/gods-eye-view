/**
 * Water Surface layer policy: the pure extent, height, visibility and
 * parameter rules behind the animated sea surface drawn over the active map
 * stack. No Cesium, DOM or i18n imports, so the tests run without WebGL.
 *
 * The surface is one rectangle of water at local mean sea level, following
 * the view. Land hides it by depth: the Google Photorealistic tileset (and a
 * terrain globe with its depth test on) sits above sea level everywhere but
 * the sea, so the rectangle only shows where the baked sea was. The height is
 * the EGM96 geoid at the view centre plus a small operator-set offset that
 * lifts it clear of the photogrammetric sea mesh.
 * @module layers/water/policy
 */

export const WATER_LAYER_ID = 'water-surface';
export const WATER_LAYER_NAME = 'Water Surface';

/** Half extent of the surface rectangle in degrees (about 40 km at 38° N). */
export const EXTENT_HALF_LON_DEG = 0.45;
export const EXTENT_HALF_LAT_DEG = 0.35;

/**
 * Wave texture cell in degrees. Rectangle edges snap to this grid and the
 * texture repeats a whole number of cells, so a rebuild around a new centre
 * keeps the wave pattern in place instead of jumping.
 */
export const WAVE_CELL_DEG = 0.0005;

/** Texture repeats across the rectangle: whole numbers by construction. */
export const WAVE_REPEAT = Object.freeze({
  s: Math.round((2 * EXTENT_HALF_LON_DEG) / WAVE_CELL_DEG),
  t: Math.round((2 * EXTENT_HALF_LAT_DEG) / WAVE_CELL_DEG),
});

/** Rebuild once the view centre is this far from the rectangle centre. */
export const REBUILD_DISTANCE_KM = 12;

/**
 * Above this camera height the baked sea reads fine on its own and the
 * rectangle's edges would show, so the surface hides.
 */
export const MAX_CAMERA_HEIGHT_M = 120_000;

/** Geometry subdivision in degrees: 1.1 km cells, a few centimetres of sag. */
export const GRANULARITY_DEG = 0.01;

/** Why the enabled surface is showing nothing (English; translated on show). */
export const HIDDEN_CAMERA_TOO_HIGH = 'Hidden above 120 km: fly closer';
export const HIDDEN_NO_VIEW = 'Waiting for the view';

export const DEFAULT_PARAMS = Object.freeze({
  /** Metres above mean sea level. Lifts the surface over the baked sea mesh. */
  offsetM: 1.2,
  /** Surface opacity. Below 1 the baked sea and boats show faintly through. */
  opacity: 0.9,
  /** Wave relief multiplier. */
  waveScale: 1,
});

export const PARAM_LIMITS = Object.freeze({
  offsetM: Object.freeze([0, 6]),
  opacity: Object.freeze([0.3, 1]),
  waveScale: Object.freeze([0.25, 2.5]),
});

const EARTH_RADIUS_KM = 6371.0088;

function clamp(value, [min, max]) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge a params patch over the previous params, keeping each value inside
 * its limits. Unknown keys and non-finite numbers are ignored.
 * @param {object} [patch]
 * @param {object} [previous]
 * @returns {{offsetM:number, opacity:number, waveScale:number}}
 */
export function normalizeWaterParams(patch = {}, previous = DEFAULT_PARAMS) {
  const next = { ...DEFAULT_PARAMS, ...previous };
  for (const key of Object.keys(PARAM_LIMITS)) {
    const value = Number(patch?.[key]);
    if (patch && Object.hasOwn(patch, key) && Number.isFinite(value))
      next[key] = clamp(value, PARAM_LIMITS[key]);
  }
  return next;
}

/**
 * Ellipsoidal height of the surface: geoid undulation N (metres, WGS84
 * ellipsoid to EGM96 mean sea level) plus the operator offset.
 * @param {number} geoidUndulationM
 * @param {number} offsetM
 * @returns {number}
 */
export function surfaceHeightM(geoidUndulationM, offsetM) {
  const n = Number.isFinite(geoidUndulationM) ? geoidUndulationM : 0;
  const offset = Number.isFinite(offsetM) ? offsetM : DEFAULT_PARAMS.offsetM;
  return n + offset;
}

/**
 * The surface rectangle around a centre, snapped to the wave-cell grid.
 * Latitudes stay inside ±85°; a rectangle that would cross the antimeridian
 * is clipped to it, so the surface simply ends there.
 * @param {number} centerLatDeg
 * @param {number} centerLonDeg
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function snapExtent(centerLatDeg, centerLonDeg) {
  if (!Number.isFinite(centerLatDeg) || !Number.isFinite(centerLonDeg))
    return null;
  const westCell = Math.floor(
    (centerLonDeg - EXTENT_HALF_LON_DEG) / WAVE_CELL_DEG,
  );
  const southCell = Math.floor(
    (centerLatDeg - EXTENT_HALF_LAT_DEG) / WAVE_CELL_DEG,
  );
  const west = Math.max(-180, westCell * WAVE_CELL_DEG);
  const east = Math.min(180, (westCell + WAVE_REPEAT.s) * WAVE_CELL_DEG);
  const south = Math.max(-85, southCell * WAVE_CELL_DEG);
  const north = Math.min(85, (southCell + WAVE_REPEAT.t) * WAVE_CELL_DEG);
  if (!(east > west) || !(north > south)) return null;
  return { west, south, east, north };
}

/**
 * Great-circle distance between two points, kilometres.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {number}
 */
export function distanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether the view centre has left the rectangle built around `current`.
 * @param {{lat:number, lon:number}|null} current Centre of the built surface.
 * @param {{lat:number, lon:number}} view Current view centre.
 * @returns {boolean}
 */
export function needsRebuild(current, view) {
  if (!current) return true;
  return distanceKm(current, view) > REBUILD_DISTANCE_KM;
}

/**
 * Why the surface should hide for this camera, or null to show it.
 * @param {number} cameraHeightM Camera height above the ellipsoid.
 * @returns {string|null}
 */
export function hiddenReason(cameraHeightM) {
  if (!Number.isFinite(cameraHeightM)) return HIDDEN_NO_VIEW;
  if (cameraHeightM > MAX_CAMERA_HEIGHT_M) return HIDDEN_CAMERA_TOO_HIGH;
  return null;
}

/** Slider positions are tenths of a metre. */
export const OFFSET_SLIDER_STEPS_PER_M = 10;

/**
 * Offset slider position for a param value, and back.
 * @param {number} offsetM
 * @returns {number}
 */
export function offsetSliderPosition(offsetM) {
  return Math.round(
    clamp(offsetM, PARAM_LIMITS.offsetM) * OFFSET_SLIDER_STEPS_PER_M,
  );
}

/**
 * @param {number|string} position
 * @returns {{offsetM:number}}
 */
export function offsetParamsForSlider(position) {
  return { offsetM: Number(position) / OFFSET_SLIDER_STEPS_PER_M };
}
