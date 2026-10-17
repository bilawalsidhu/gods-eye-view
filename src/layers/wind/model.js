/** Normalize a longitude into the half-open world interval. */
export function normalizeLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function interpolate(array, a, b, c, d, tx, ty) {
  return (
    (array[a] * (1 - tx) + array[b] * tx) * (1 - ty) +
    (array[c] * (1 - tx) + array[d] * tx) * ty
  );
}

/**
 * Sample a north-to-south wind grid bilinearly. Periodic grids wrap the seam
 * and clamp latitude (the original behaviour); a non-periodic grid rejects
 * points outside it, and a finite `noData` sentinel in any weighted corner
 * rejects the sample. Rejection is `u = v = NaN`, which every consumer
 * already treats as "no vector here".
 */
export function sampleWind(field, lon, lat, result = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    result.u = 0;
    result.v = 0;
    return result;
  }
  const { u, v, nx, ny, lo1, la1, dx, dy } = field;
  const periodic = field.periodic !== false;
  const x = ((normalizeLongitude(lon - lo1) + 360) % 360) / dx;
  const y = (la1 - lat) / dy;
  if (!periodic && (x > nx - 1 || y < 0 || y > ny - 1)) {
    result.u = NaN;
    result.v = NaN;
    return result;
  }
  const x0 = Math.floor(x);
  const tx = x - x0;
  const yClamped = Math.max(0, Math.min(ny - 1, y));
  const y0 = Math.floor(yClamped);
  const y1 = Math.min(ny - 1, y0 + 1);
  const ty = yClamped - y0;
  const left = ((x0 % nx) + nx) % nx;
  const right = periodic ? (left + 1) % nx : Math.min(left + 1, nx - 1);
  const a = y0 * nx + left;
  const b = y0 * nx + right;
  const c = y1 * nx + left;
  const d = y1 * nx + right;
  const sentinel = field.noData;
  if (
    Number.isFinite(sentinel) &&
    (u[a] === sentinel ||
      (tx > 0 && u[b] === sentinel) ||
      (ty > 0 && (u[c] === sentinel || (tx > 0 && u[d] === sentinel))))
  ) {
    result.u = NaN;
    result.v = NaN;
    return result;
  }
  result.u = interpolate(u, a, b, c, d, tx, ty);
  result.v = interpolate(v, a, b, c, d, tx, ty);
  return result;
}

/** Clip a spawn range to a field box; `null` when they do not overlap. */
export function intersectBounds(bounds, bbox) {
  if (!bbox) return bounds;
  const degree = Math.PI / 180;
  let west = bbox.lonMin;
  let east = bbox.lonMax;
  if (east < west) east += 360;
  // Shift the box by whole turns onto the view's unwrapped frame.
  while (east < bounds.west) {
    west += 360;
    east += 360;
  }
  while (west > bounds.east) {
    west -= 360;
    east -= 360;
  }
  const outWest = Math.max(bounds.west, west);
  const outEast = Math.min(bounds.east, east);
  const sinSouth = Math.max(bounds.sinSouth, Math.sin(bbox.latMin * degree));
  const sinNorth = Math.min(bounds.sinNorth, Math.sin(bbox.latMax * degree));
  if (!(outEast > outWest) || !(sinNorth > sinSouth)) return null;
  return { west: outWest, east: outEast, sinSouth, sinNorth };
}

/** Return metres represented by one longitude degree at a latitude. */
export function metersPerDegreeLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Calculate wind magnitude. */
export function windSpeed(u, v) {
  return Math.hypot(u, v);
}

/** Map wind magnitude to a fixed CSS colour ramp (calm blue → strong red). */
export function windColor(speed, { max = 30 } = {}) {
  const stops = [
    '#1e3a8a',
    '#2563eb',
    '#22d3ee',
    '#34d399',
    '#fbbf24',
    '#f97316',
    '#ef4444',
  ];
  const t = Math.max(0, Math.min(1, speed / max));
  const position = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - index;
  if (t === 1) return stops.at(-1);
  const parse = (color) =>
    color.match(/\w\w/g).map((part) => parseInt(part, 16));
  const a = parse(stops[index]);
  const b = parse(stops[index + 1]);
  return `rgb(${a.map((value, i) => Math.round(value + (b[i] - value) * fraction)).join(', ')})`;
}

/** Advance a particle by a wind vector, mutating and returning it. */
export function advectParticle(
  particle,
  wind,
  dtSeconds,
  { speedScale = 1 } = {},
) {
  particle.lon = normalizeLongitude(
    particle.lon +
      (wind.u * dtSeconds * speedScale) / metersPerDegreeLon(particle.lat),
  );
  particle.lat = Math.max(
    -89,
    Math.min(89, particle.lat + (wind.v * dtSeconds * speedScale) / 111320),
  );
  return particle;
}
