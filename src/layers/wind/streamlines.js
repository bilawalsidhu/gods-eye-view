import { metersPerDegreeLon, normalizeLongitude, sampleWind } from './model.js';
import { fieldStepCap } from './fieldSpec.js';

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

/** One bounded midpoint step. The integration interval is field time, not playback time. */
function advance(field, point, seconds, scratch, maxStepDegrees, calmCutoffMs) {
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
  // A bounded grid ends the path at its last valid point rather than stepping
  // onto land, outside the box or into a no-data cell.
  if (field.periodic === false) {
    sampleWind(field, lon, lat, scratch);
    if (!Number.isFinite(scratch.u + scratch.v)) return null;
  }
  return [lon, lat];
}

/** Equal-area seed: golden-angle longitude, uniform in sin(latitude). */
function seedPoint(seed, budget, bbox) {
  if (!bbox) {
    return [
      normalizeLongitude(seed * GOLDEN_ANGLE),
      (Math.asin(
        (((seed + 0.5) / budget) * 2 - 1) * Math.sin((88 * Math.PI) / 180),
      ) *
        180) /
        Math.PI,
    ];
  }
  const degree = Math.PI / 180;
  const lonSpan = (((bbox.lonMax - bbox.lonMin) % 360) + 360) % 360 || 360;
  const sinSouth = Math.sin(Math.max(-88, bbox.latMin) * degree);
  const sinNorth = Math.sin(Math.min(88, bbox.latMax) * degree);
  const lon = normalizeLongitude(
    bbox.lonMin + (((seed * GOLDEN_ANGLE) % 360) / 360) * lonSpan,
  );
  const lat =
    Math.asin(sinSouth + ((seed + 0.5) / budget) * (sinNorth - sinSouth)) /
    degree;
  return [lon, lat];
}

/**
 * Bake geographic streamlines once from an immutable forecast snapshot.
 * Equal-area seeds avoid polar overpopulation. Increasing path position always
 * follows the wind; paths stop at the map seam, poles, calm or missing samples.
 * A field with a `bbox` is seeded equal-area inside that box instead of the
 * whole sphere; `calmCutoffMs` and `maxStepDegrees` default to the wind
 * constants (0.15 m/s, 0.75 deg for a global grid).
 */
export function bakeWindStreamlines(
  field,
  {
    count = WIND_PATH_LIMIT,
    steps = WIND_PATH_STEPS,
    stepSeconds = 1800,
    calmCutoffMs = 0.15,
    maxStepDegrees,
    bbox,
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
    MAX_STEP_SECONDS,
    Math.max(1, Number.isFinite(stepSeconds) ? stepSeconds : 1800),
  );
  const stepCap =
    Number.isFinite(maxStepDegrees) && maxStepDegrees > 0
      ? maxStepDegrees
      : fieldStepCap(field);
  const box = bbox === undefined ? (field.bbox ?? null) : bbox;
  const calm = Number.isFinite(calmCutoffMs) ? calmCutoffMs : 0.15;
  const paths = [];
  const scratch = { u: 0, v: 0 };
  for (let seed = 0; seed < budget; seed++) {
    const center = seedPoint(seed, budget, box);
    sampleWind(field, center[0], center[1], scratch);
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
