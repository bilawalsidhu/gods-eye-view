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

/** One bounded midpoint step. The integration interval is field time, not playback time. */
function advance(field, point, seconds, scratch, bounds = null) {
  sampleWind(field, point[0], point[1], scratch);
  if (
    !Number.isFinite(scratch.u + scratch.v) ||
    Math.hypot(scratch.u, scratch.v) < 0.15
  )
    return null;
  const lonRate = scratch.u / metersPerDegreeLon(point[1]);
  const latRate = scratch.v / DEGREE_METERS;
  // Bound each geographic segment, including fast winds near the poles.
  const dt =
    Math.sign(seconds) *
    Math.min(
      Math.abs(seconds),
      0.75 / Math.max(Math.abs(lonRate), Math.abs(latRate), 1e-12),
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
  return [lon, lat];
}

/**
 * Bake geographic streamlines once from an immutable forecast snapshot.
 * Equal-area seeds avoid polar overpopulation. Increasing path position always
 * follows the wind; paths stop at the map seam, poles, calm or missing samples.
 * With `bounds` (a field over part of the globe: degrees, east of west, east
 * past 180° across the antimeridian), seeds fall inside it, equal-area, and
 * paths stop at its edges.
 */
export function bakeWindStreamlines(
  field,
  {
    count = WIND_PATH_LIMIT,
    steps = WIND_PATH_STEPS,
    stepSeconds = 1800,
    bounds = null,
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
  const budget = Math.min(
    WIND_PATH_LIMIT,
    Math.max(0, Math.floor(Number.isFinite(count) ? count : WIND_PATH_LIMIT)),
  );
  const halfSteps = Math.min(
    WIND_PATH_STEPS,
    Math.max(1, Math.floor(Number.isFinite(steps) ? steps : WIND_PATH_STEPS)),
  );
  const interval = Math.min(
    3600,
    Math.max(1, Number.isFinite(stepSeconds) ? stepSeconds : 1800),
  );
  const paths = [];
  const scratch = { u: 0, v: 0 };
  const rad = Math.PI / 180;
  const south = Math.max(-88, bounds ? bounds.south : -88) * rad;
  const north = Math.min(88, bounds ? bounds.north : 88) * rad;
  const lonSpan = bounds ? bounds.east - bounds.west : 360;
  for (let seed = 0; seed < budget; seed++) {
    const lon = bounds
      ? normalizeLongitude(bounds.west + ((seed * GOLDEN_ANGLE) % lonSpan))
      : normalizeLongitude(seed * GOLDEN_ANGLE);
    const share = (seed + 0.5) / budget;
    const lat =
      Math.asin(Math.sin(south) + share * (Math.sin(north) - Math.sin(south))) /
      rad;
    const center = [lon, lat];
    sampleWind(field, lon, lat, scratch);
    const speed = Math.hypot(scratch.u, scratch.v);
    if (!Number.isFinite(speed) || speed < 0.15) continue;
    const backward = [];
    const forward = [];
    for (const [direction, points] of [
      [-1, backward],
      [1, forward],
    ]) {
      let point = center;
      for (let step = 0; step < halfSteps; step++) {
        point = advance(field, point, direction * interval, scratch, bounds);
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
