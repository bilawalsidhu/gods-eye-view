/**
 * Terrain horizon profile for one observer: the highest terrain elevation
 * angle in each azimuth bin, used to dim (or hide) sky objects that are behind
 * a hill. 180 azimuths x 24 log-spaced distances (100 m .. 60 km) = 4,320
 * points sampled in ONE terrain-height batch (`heightsOf(viewer).batch`), then
 * the maximum elevation angle per azimuth including the Earth-curvature drop
 * d^2 / 2R.
 *
 * Buildings and trees in Google 3D tiles are not terrain and are not in the
 * profile (documented limitation). With no real terrain the profile is
 * skipped (null) and callers hide objects below 0 deg.
 */
import { heightsOf } from '../queries/heights.js';
import { DEG, normalizeAz } from './skyMath.js';
import { observerEyeHeight } from './observer.js';

export const EARTH_RADIUS_M = 6_371_008.8;
export const PROFILE_AZ_COUNT = 180;
export const PROFILE_DISTANCE_COUNT = 24;
export const PROFILE_MIN_M = 100;
export const PROFILE_MAX_M = 60_000;

/** Log-spaced sample distances in metres, first = min, last = max. */
export function profileDistances(
  count = PROFILE_DISTANCE_COUNT,
  minM = PROFILE_MIN_M,
  maxM = PROFILE_MAX_M,
) {
  const ratio = Math.pow(maxM / minM, 1 / (count - 1));
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? maxM : minM * Math.pow(ratio, i),
  );
}

/** Great-circle destination (degrees) from a start, bearing and distance. */
export function destination(
  latDeg,
  lonDeg,
  bearingDeg,
  distanceM,
  radiusM = EARTH_RADIUS_M,
) {
  const phi1 = latDeg * DEG;
  const lambda1 = lonDeg * DEG;
  const theta = bearingDeg * DEG;
  const delta = distanceM / radiusM;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );
  let lonOut = lambda2 / DEG;
  lonOut = ((((lonOut + 180) % 360) + 360) % 360) - 180;
  return { latDeg: phi2 / DEG, lonDeg: lonOut };
}

/**
 * Elevation angle (degrees) of a terrain point `distanceM` away whose height
 * is `pointHeightM`, seen from an eye at `eyeHeightM` (both above the
 * ellipsoid), with the curvature drop d^2 / (2R).
 */
export function elevationAngle(
  distanceM,
  pointHeightM,
  eyeHeightM,
  radiusM = EARTH_RADIUS_M,
) {
  const drop = (distanceM * distanceM) / (2 * radiusM);
  return Math.atan2(pointHeightM - eyeHeightM - drop, distanceM) / DEG;
}

/** The sample grid, azimuth-major: index = az * distances.length + d. */
export function profileSamplePoints(
  latDeg,
  lonDeg,
  { azCount = PROFILE_AZ_COUNT, distances = profileDistances() } = {},
) {
  const points = [];
  for (let a = 0; a < azCount; a++) {
    const bearing = (a * 360) / azCount;
    for (const distanceM of distances)
      points.push({
        ...destination(latDeg, lonDeg, bearing, distanceM),
        distanceM,
        bearing,
      });
  }
  return points;
}

/**
 * Reduce sampled heights to a profile. `heights[i]` belongs to `points[i]`;
 * non-finite heights are skipped. Returns { azCount, anglesDeg: Float64Array }
 * or null when no azimuth got a single valid sample.
 */
export function buildProfile(
  points,
  heights,
  eyeHeightM,
  azCount = PROFILE_AZ_COUNT,
) {
  const angles = new Float64Array(azCount).fill(Number.NEGATIVE_INFINITY);
  const perAz = points.length / azCount;
  let valid = 0;
  for (let i = 0; i < points.length; i++) {
    const h = heights[i];
    if (!Number.isFinite(h)) continue;
    const a = Math.floor(i / perAz);
    const angle = elevationAngle(points[i].distanceM, h, eyeHeightM);
    if (angle > angles[a]) angles[a] = angle;
    valid += 1;
  }
  if (!valid) return null;
  // An azimuth with no data takes the geometric horizon (0 deg): honest default.
  for (let a = 0; a < azCount; a++)
    if (!Number.isFinite(angles[a])) angles[a] = 0;
  return { azCount, anglesDeg: angles };
}

/** Terrain horizon elevation at an azimuth, linearly interpolated; 0 with no profile. */
export function horizonAt(profile, azDeg) {
  if (!profile) return 0;
  const { azCount, anglesDeg } = profile;
  const x = (normalizeAz(azDeg) / 360) * azCount;
  const i0 = Math.floor(x) % azCount;
  const i1 = (i0 + 1) % azCount;
  const t = x - Math.floor(x);
  return anglesDeg[i0] * (1 - t) + anglesDeg[i1] * t;
}

/** 'clear' | 'terrain' (behind the profile) | 'below' (below 0 with no profile). */
export function occlusion(profile, azDeg, elDeg) {
  if (!profile) return elDeg < 0 ? 'below' : 'clear';
  return elDeg < horizonAt(profile, azDeg) ? 'terrain' : 'clear';
}

/**
 * Sample the real terrain once (one batch through the height service) and
 * build the profile. Resolves null (skip) when there is no real terrain (a
 * point the terrain does not answer, or the bare ellipsoid answers, is a
 * miss, and no valid sample builds no profile), sampling fails or exceeds the
 * time budget. Never throws.
 * @param {object} options
 * @param {object} options.viewer The application's scene object.
 */
export async function computeHorizonProfile({
  viewer,
  observer,
  timeoutMs = 8000,
  azCount = PROFILE_AZ_COUNT,
  distances = profileDistances(),
}) {
  if (!observer || !viewer) return null;
  const points = profileSamplePoints(observer.latDeg, observer.lonDeg, {
    azCount,
    distances,
  });
  let timer;
  try {
    const heights = await Promise.race([
      heightsOf(viewer).batch(
        points.map((p) => ({ lon: p.lonDeg, lat: p.latDeg })),
        { against: 'terrain', ellipsoidMisses: true },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return buildProfile(points, heights, observerEyeHeight(observer), azCount);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
