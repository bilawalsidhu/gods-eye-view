/** Normalize a longitude into the half-open world interval. */
export function normalizeLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

const cell = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 };

/**
 * The four indexes of a north-to-south, seam-wrapped grid around (lon, lat)
 * and the weights between them, in one shared object: read it before the
 * next call.
 */
export function gridCell({ nx, ny, lo1, la1, dx, dy }, lon, lat) {
  const x = ((normalizeLongitude(lon - lo1) + 360) % 360) / dx;
  const y = (la1 - lat) / dy;
  const x0 = Math.floor(x);
  const tx = x - x0;
  const yClamped = Math.max(0, Math.min(ny - 1, y));
  const y0 = Math.floor(yClamped);
  const y1 = Math.min(ny - 1, y0 + 1);
  const ty = yClamped - y0;
  const left = ((x0 % nx) + nx) % nx;
  const right = (left + 1) % nx;
  cell.a = y0 * nx + left;
  cell.b = y0 * nx + right;
  cell.c = y1 * nx + left;
  cell.d = y1 * nx + right;
  cell.tx = tx;
  cell.ty = ty;
  return cell;
}

/** Bilinear value of `values` at a gridCell(). */
export function interpolateCell(values, { a, b, c, d, tx, ty }) {
  return (
    (values[a] * (1 - tx) + values[b] * tx) * (1 - ty) +
    (values[c] * (1 - tx) + values[d] * tx) * ty
  );
}

/** Sample a north-to-south, seam-wrapped wind grid bilinearly. */
export function sampleWind(field, lon, lat, result = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    result.u = 0;
    result.v = 0;
    return result;
  }
  const at = gridCell(field, lon, lat);
  result.u = interpolateCell(field.u, at);
  result.v = interpolateCell(field.v, at);
  return result;
}

/** Return metres represented by one longitude degree at a latitude. */
export function metersPerDegreeLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Calculate wind magnitude. */
export function windSpeed(u, v) {
  return Math.hypot(u, v);
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
