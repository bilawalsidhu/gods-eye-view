// src/bench/syntheticFlights.js
const EARTH_RADIUS_M = 6_371_000;
const RADIANS = Math.PI / 180;

/** Small deterministic PRNG so both engines draw the same fleet. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapLongitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

function checkNear(near, count) {
  if (!Number.isInteger(near.count) || near.count < 0 || near.count > count)
    throw new RangeError('near.count must be an integer in [0, count]');
  if (!(near.radiusM >= 0) || !Number.isFinite(near.radiusM))
    throw new RangeError('near.radiusM must be a non-negative number');
  if (!Number.isFinite(near.lat) || !Number.isFinite(near.lng))
    throw new RangeError('near.lat and near.lng must be finite');
  const bands = nearBands(near);
  if (
    !(bands.minAltM <= bands.maxAltM) ||
    !(bands.minSpeedMps <= bands.maxSpeedMps)
  )
    throw new RangeError('near altitude and speed bands must be ordered');
}

const nearBands = ({
  minAltM = 300,
  maxAltM = 3_000,
  minSpeedMps = 10,
  maxSpeedMps = 40,
}) => ({ minAltM, maxAltM, minSpeedMps, maxSpeedMps });

/**
 * Deterministic synthetic aircraft for engine benchmarks. Each aircraft
 * flies a great circle at constant speed on a spherical Earth.
 *
 * With `near: { lat, lng, radiusM, count }` the first `count` aircraft start
 * uniformly over the disc of `radiusM` around that point, at `minAltM` to
 * `maxAltM` (default 300–3000 m) and `minSpeedMps` to `maxSpeedMps` (default
 * 10–40 m/s, slow enough to stay near the point for a bench run); the rest
 * spread over the globe as without `near`.
 */
export function createSyntheticFlights({ count, seed = 1, near = null }) {
  if (!Number.isInteger(count) || count < 0)
    throw new RangeError('count must be a non-negative integer');
  if (near) checkNear(near, count);
  const random = mulberry32(seed);
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  const alt = new Float64Array(count);
  const heading = new Float64Array(count);
  const speed = new Float64Array(count);
  const nearCount = near ? near.count : 0;
  const bands = near ? nearBands(near) : null;
  for (let i = 0; i < nearCount; i++) {
    // Uniform over the disc: r = R·sqrt(u), then the spherical destination.
    const distance = (near.radiusM * Math.sqrt(random())) / EARTH_RADIUS_M;
    const bearing = random() * 2 * Math.PI;
    const phi1 = near.lat * RADIANS;
    const sinPhi2 =
      Math.sin(phi1) * Math.cos(distance) +
      Math.cos(phi1) * Math.sin(distance) * Math.cos(bearing);
    const phi2 = Math.asin(sinPhi2);
    const dLambda = Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(phi1),
      Math.cos(distance) - Math.sin(phi1) * sinPhi2,
    );
    lat[i] = phi2 / RADIANS;
    lon[i] = wrapLongitude(near.lng + dLambda / RADIANS);
    alt[i] = bands.minAltM + random() * (bands.maxAltM - bands.minAltM);
    heading[i] = random() * 360;
    speed[i] =
      bands.minSpeedMps + random() * (bands.maxSpeedMps - bands.minSpeedMps);
  }
  for (let i = nearCount; i < count; i++) {
    lat[i] = Math.asin(2 * random() - 1) / RADIANS;
    lon[i] = random() * 360 - 180;
    alt[i] = 1_000 + random() * 11_000;
    heading[i] = random() * 360;
    speed[i] = 120 + random() * 130;
  }

  function advance(dtSeconds) {
    for (let i = 0; i < count; i++) {
      const distance = (speed[i] * dtSeconds) / EARTH_RADIUS_M;
      const phi1 = lat[i] * RADIANS;
      const theta = heading[i] * RADIANS;
      const sinPhi2 =
        Math.sin(phi1) * Math.cos(distance) +
        Math.cos(phi1) * Math.sin(distance) * Math.cos(theta);
      const phi2 = Math.asin(sinPhi2);
      const dLambda = Math.atan2(
        Math.sin(theta) * Math.sin(distance) * Math.cos(phi1),
        Math.cos(distance) - Math.sin(phi1) * sinPhi2,
      );
      lat[i] = phi2 / RADIANS;
      lon[i] = wrapLongitude(lon[i] + dLambda / RADIANS);
    }
  }

  return { count, lat, lon, alt, heading, speed, advance };
}
