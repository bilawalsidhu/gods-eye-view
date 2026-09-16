import { metersPerDegreeLon, normalizeLongitude, sampleWind } from './model.js';

// Desktop density is bounded independently of viewport zoom; camera motion
// never triggers a regional rebake. Narrow-screen cost stays at 1200 paths.
export const WIND_PATH_LIMIT = 7200;
export const WIND_NARROW_PATH_LIMIT = 1200;
export const WIND_PATH_STEPS = 16;
export const WIND_DISPLAY_HEIGHT_METERS = 12000;
const DEGREE_METERS = 111320;
const GOLDEN_ANGLE = 137.50776405003785;

/** One bounded midpoint step. The integration interval is field time, not playback time. */
function advance(field, point, seconds, scratch) {
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
  return [lon, lat];
}

/**
 * Bake geographic streamlines once from an immutable forecast snapshot.
 * Equal-area seeds avoid polar overpopulation. Increasing path position always
 * follows the wind; paths stop at the map seam, poles, calm or missing samples.
 */
export function bakeWindStreamlines(
  field,
  { count = WIND_PATH_LIMIT, steps = WIND_PATH_STEPS, stepSeconds = 1800 } = {},
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
  for (let seed = 0; seed < budget; seed++) {
    const lon = normalizeLongitude(seed * GOLDEN_ANGLE);
    const lat =
      (Math.asin(
        (((seed + 0.5) / budget) * 2 - 1) * Math.sin((88 * Math.PI) / 180),
      ) *
        180) /
      Math.PI;
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
        point = advance(field, point, direction * interval, scratch);
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
