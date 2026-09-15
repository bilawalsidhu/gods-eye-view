/** Normalize a longitude into the half-open world interval. */
export function normalizeLongitude(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** Sample a north-to-south, seam-wrapped wind grid bilinearly. */
export function sampleWind(field, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { u: 0, v: 0 };
  const { u, v, nx, ny, lo1, la1, dx, dy } = field;
  const x = ((normalizeLongitude(lon - lo1) + 360) % 360) / dx;
  const y = (la1 - lat) / dy;
  const x0 = Math.floor(x);
  const tx = x - x0;
  const yClamped = Math.max(0, Math.min(ny - 1, y));
  const y0 = Math.floor(yClamped);
  const y1 = Math.min(ny - 1, y0 + 1);
  const ty = yClamped - y0;
  const column = (index) => ((index % nx) + nx) % nx;
  const value = (array) => {
    const a = array[y0 * nx + column(x0)];
    const b = array[y0 * nx + column(x0 + 1)];
    const c = array[y1 * nx + column(x0)];
    const d = array[y1 * nx + column(x0 + 1)];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  return { u: value(u), v: value(v) };
}

/** Return metres represented by one longitude degree at a latitude. */
export function metersPerDegreeLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** Calculate wind magnitude. */
export function windSpeed(u, v) {
  return Math.hypot(u, v);
}

/** Map wind magnitude to a fixed CSS colour ramp (bright from calm upward). */
export function windColor(speed, { max = 30 } = {}) {
  const stops = ['#38bdf8', '#22d3ee', '#34d399', '#fbbf24', '#f87171'];
  const t = Math.max(0, Math.min(1, speed / max));
  const position = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - index;
  if (t === 1) return stops.at(-1);
  const parse = (color) => color.match(/\w\w/g).map((part) => parseInt(part, 16));
  const a = parse(stops[index]);
  const b = parse(stops[index + 1]);
  return `rgb(${a.map((value, i) => Math.round(value + (b[i] - value) * fraction)).join(', ')})`;
}

/** Advance a particle by a wind vector, mutating and returning it. */
export function advectParticle(particle, wind, dtSeconds, { speedScale = 1 } = {}) {
  particle.lon = normalizeLongitude(
    particle.lon + (wind.u * dtSeconds * speedScale) / metersPerDegreeLon(particle.lat),
  );
  particle.lat = Math.max(-89, Math.min(89, particle.lat + (wind.v * dtSeconds * speedScale) / 111320));
  return particle;
}
