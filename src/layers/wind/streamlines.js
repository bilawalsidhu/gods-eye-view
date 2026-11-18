import { metersPerDegreeLon, normalizeLongitude, sampleWind } from './model.js';

// Desktop density is bounded independently of viewport zoom; camera motion
// never triggers a regional rebake. Narrow-screen cost stays at 1200 paths.
export const WIND_PATH_LIMIT = 7200;
export const WIND_NARROW_PATH_LIMIT = 1200;
export const WIND_PATH_STEPS = 16;
export const WIND_DISPLAY_HEIGHT_METERS = 12000;
export const WIND_CELL_DEGREES = 30;
const DEGREE_METERS = 111320;
const GOLDEN_ANGLE = 137.50776405003785;
// Upper bound on one integration step; the old canvas' MAX_SECONDS_PER_FRAME.
const MAX_STEP_SECONDS = 4e6;

/**
 * Per-step geographic bound in degrees: 0.75 for global grids (today's
 * constant), span/64 for regional ones so a 16-step half path never exceeds
 * a quarter of the field's longer side.
 */
export function fieldStepCap(field) {
  const span = Math.max(field.nx * field.dx, (field.ny - 1) * field.dy);
  if (!Number.isFinite(span) || span <= 0) return 0.75;
  return Math.min(0.75, span / 64);
}

/**
 * Whether a point is inside `bounds` (a rectangle in degrees, east of west;
 * east may run past 180°), or there are none.
 */
function within(bounds, lon, lat) {
  if (!bounds) return true;
  if (lat < bounds.south || lat > bounds.north) return false;
  const span = bounds.east - bounds.west;
  return (((lon - bounds.west) % 360) + 360) % 360 <= span;
}

/**
 * A field's `bbox` (`lonMin`/`lonMax`/`latMin`/`latMax`, degrees) as bake
 * bounds; null without one. A box that wraps every longitude keeps only its
 * latitudes.
 */
export function boundsOfBox(bbox) {
  if (!bbox) return null;
  const span = (((bbox.lonMax - bbox.lonMin) % 360) + 360) % 360 || 360;
  return {
    west: bbox.lonMin,
    south: bbox.latMin,
    east: bbox.lonMin + span,
    north: bbox.latMax,
  };
}

/** One bounded midpoint step. The integration interval is field time, not playback time. */
function advance(
  field,
  point,
  seconds,
  scratch,
  maxStepDegrees,
  calmCutoffMs,
  bounds,
) {
  sampleWind(field, point[0], point[1], scratch);
  if (
    !Number.isFinite(scratch.u + scratch.v) ||
    Math.hypot(scratch.u, scratch.v) < calmCutoffMs
  )
    return null;
  const lonRate = scratch.u / metersPerDegreeLon(point[1]);
  const latRate = scratch.v / DEGREE_METERS;
  // Bound each geographic segment, including fast winds near the poles.
  const dt =
    Math.sign(seconds) *
    Math.min(
      Math.abs(seconds),
      maxStepDegrees / Math.max(Math.abs(lonRate), Math.abs(latRate), 1e-12),
    );
  const midLat = point[1] + latRate * dt * 0.5;
  if (Math.abs(midLat) > 88.5) return null;
  sampleWind(field, point[0] + lonRate * dt * 0.5, midLat, scratch);
  if (!Number.isFinite(scratch.u + scratch.v)) return null;
  const lon = normalizeLongitude(
    point[0] + (scratch.u * dt) / metersPerDegreeLon(midLat),
  );
  const lat = point[1] + (scratch.v * dt) / DEGREE_METERS;
  if (Math.abs(lat) > 88.5 || Math.abs(lon - point[0]) > 180) return null;
  if (Math.abs(lon - point[0]) + Math.abs(lat - point[1]) < 1e-8) return null;
  if (!within(bounds, lon, lat)) return null;
  // A bounded grid ends the path at its last valid point rather than stepping
  // onto land, outside the box or into a no-data cell.
  if (field.periodic === false) {
    sampleWind(field, lon, lat, scratch);
    if (!Number.isFinite(scratch.u + scratch.v)) return null;
  }
  return [lon, lat];
}

/**
 * Bake geographic streamlines once from an immutable forecast snapshot.
 * Equal-area seeds avoid polar overpopulation. Increasing path position always
 * follows the wind; paths stop at the map seam, poles, calm or missing samples.
 * With `bounds` (a field over part of the globe: degrees, east of west, east
 * past 180° across the antimeridian), seeds fall inside it, equal-area, and
 * paths stop at its edges; left undefined, a field's own `bbox` gives them.
 * Seed longitudes advance by the golden-ratio fraction of the span, so the
 * seeds form a Fibonacci lattice whatever the span is. `maxCount` raises the
 * seed ceiling above WIND_PATH_LIMIT for sparse fields (ocean globe);
 * `calmCutoffMs` and `maxStepDegrees` default to the wind constants
 * (0.15 m/s, 0.75 deg for a global grid).
 */
export function bakeWindStreamlines(
  field,
  {
    count = WIND_PATH_LIMIT,
    maxCount = WIND_PATH_LIMIT,
    steps = WIND_PATH_STEPS,
    stepSeconds = 1800,
    calmCutoffMs = 0.15,
    maxStepDegrees,
    bounds,
  } = {},
) {
  if (
    !field ||
    field.nx < 2 ||
    field.ny < 2 ||
    !(field.dx > 0) ||
    !(field.dy > 0) ||
    !field.u ||
    !field.v
  )
    return [];
  // The ceiling is the caller's: a field spec may seed a sparse field past
  // the wind limit, but never below it.
  const ceiling = Math.max(
    WIND_PATH_LIMIT,
    Number.isFinite(maxCount) ? Math.floor(maxCount) : WIND_PATH_LIMIT,
  );
  const budget = Math.min(
    ceiling,
    Math.max(0, Math.floor(Number.isFinite(count) ? count : WIND_PATH_LIMIT)),
  );
  const halfSteps = Math.min(
    WIND_PATH_STEPS,
    Math.max(1, Math.floor(Number.isFinite(steps) ? steps : WIND_PATH_STEPS)),
  );
  const interval = Math.min(
    MAX_STEP_SECONDS,
    Math.max(1, Number.isFinite(stepSeconds) ? stepSeconds : 1800),
  );
  const stepCap =
    Number.isFinite(maxStepDegrees) && maxStepDegrees > 0
      ? maxStepDegrees
      : fieldStepCap(field);
  const box = bounds === undefined ? boundsOfBox(field.bbox) : bounds;
  const calm = Number.isFinite(calmCutoffMs) ? calmCutoffMs : 0.15;
  const paths = [];
  const scratch = { u: 0, v: 0 };
  const rad = Math.PI / 180;
  const south = Math.max(-88, box ? box.south : -88) * rad;
  const north = Math.min(88, box ? box.north : 88) * rad;
  const lonSpan = box ? box.east - box.west : 360;
  for (let seed = 0; seed < budget; seed++) {
    const lon = box
      ? normalizeLongitude(
          box.west + (((seed * GOLDEN_ANGLE) % 360) / 360) * lonSpan,
        )
      : normalizeLongitude(seed * GOLDEN_ANGLE);
    const share = (seed + 0.5) / budget;
    const lat =
      Math.asin(Math.sin(south) + share * (Math.sin(north) - Math.sin(south))) /
      rad;
    const center = [lon, lat];
    sampleWind(field, lon, lat, scratch);
    const speed = Math.hypot(scratch.u, scratch.v);
    if (!Number.isFinite(speed) || speed < calm) continue;
    const backward = [];
    const forward = [];
    for (const [direction, points] of [
      [-1, backward],
      [1, forward],
    ]) {
      let point = center;
      for (let step = 0; step < halfSteps; step++) {
        point = advance(
          field,
          point,
          direction * interval,
          scratch,
          stepCap,
          calm,
          box,
        );
        if (!point) break;
        points.push(point);
      }
    }
    const coordinates = [...backward.reverse(), center, ...forward];
    if (coordinates.length < 3) continue;
    paths.push({
      coordinates,
      speed,
      seed,
      phase: ((seed + 1) * 0.6180339887498949) % 1,
    });
  }
  return paths;
}

/**
 * Summed path length in degrees (longitude scaled by cos latitude, no
 * great-circle correction) divided by the span in degrees: the line
 * coverage the seed budget targets. 0 for an empty set or a zero span.
 */
export function measureLineCoverage(paths, spanDeg) {
  if (!(spanDeg > 0)) return 0;
  const degree = Math.PI / 180;
  let total = 0;
  for (const path of paths) {
    const points = path.coordinates;
    for (let i = 1; i < points.length; i++) {
      const [lon0, lat0] = points[i - 1];
      const [lon1, lat1] = points[i];
      const dlon =
        normalizeLongitude(lon1 - lon0) *
        Math.cos(((lat0 + lat1) / 2) * degree);
      total += Math.hypot(dlon, lat1 - lat0);
    }
  }
  return total / spanDeg;
}

/** Group baked paths by their middle coordinate, preserving path and cell order. */
export function groupWindPaths(paths, cellDegrees = WIND_CELL_DEGREES) {
  if (!Number.isFinite(cellDegrees) || cellDegrees <= 0 || cellDegrees > 180)
    throw new RangeError('Wind cell size must be between 0 and 180 degrees');
  const columns = Math.ceil(360 / cellDegrees);
  const rows = Math.ceil(180 / cellDegrees);
  const cells = new Map();
  for (const path of paths) {
    const [lon, lat] =
      path.coordinates[Math.floor(path.coordinates.length / 2)];
    const column = Math.floor((normalizeLongitude(lon) + 180) / cellDegrees);
    const row = Math.min(
      rows - 1,
      Math.max(0, Math.floor((lat + 90) / cellDegrees)),
    );
    const id = row * columns + column;
    let cell = cells.get(id);
    if (!cell) {
      cell = { id, paths: [] };
      cells.set(id, cell);
    }
    cell.paths.push(path);
  }
  return [...cells.values()];
}
