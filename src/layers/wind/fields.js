import { normalizeLongitude, sampleWind } from './model.js';

/** Fixed physical scales shared by imagery and the field legend. */
export const WIND_FIELDS = Object.freeze({
  speed: Object.freeze({
    label: 'Wind speed',
    units: 'm/s',
    min: 0,
    max: 30,
    stops: ['#133a67', '#2876a3', '#66c9d1', '#c8dfac', '#f1cf79', '#ee9761'],
  }),
  temperature: Object.freeze({
    label: '2 m air temperature',
    units: '°C',
    min: -40,
    max: 50,
    // Fixed 10°C anchors keep model comparisons honest while making everyday
    // temperature gradients distinguishable from the underlying basemap.
    stops: [
      '#31235b',
      '#403b92',
      '#315fc1',
      '#268fce',
      '#31bdd0',
      '#8ad4aa',
      '#f0d255',
      '#ee8a34',
      '#d74638',
      '#9f274d',
    ],
  }),
  pressure: Object.freeze({
    label: 'Mean sea-level pressure',
    units: 'hPa',
    min: 960,
    max: 1050,
    stops: ['#705ca0', '#6985b4', '#a5c3cd', '#d8c99a', '#dbad61'],
  }),
});

function palette(stops) {
  const rgb = stops.map((color) =>
    color.match(/\w\w/g).map((value) => parseInt(value, 16)),
  );
  return Array.from({ length: 128 }, (_, i) => {
    const p = (i / 127) * (rgb.length - 1);
    const a = Math.min(rgb.length - 2, Math.floor(p));
    return rgb[a].map((value, channel) =>
      Math.round(value + (rgb[a + 1][channel] - value) * (p - a)),
    );
  });
}
const PALETTES = Object.fromEntries(
  Object.entries(WIND_FIELDS).map(([kind, spec]) => [
    kind,
    palette(spec.stops),
  ]),
);
const WIND_COLORS = PALETTES.speed.map((rgb) => `rgb(${rgb.join(',')})`);
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

/** No parsing, arrays or CSS interpolation in the particle loop. */
export function windTrailColor(speed) {
  return WIND_COLORS[
    Math.round((clamp(Number.isFinite(speed) ? speed : 0, 0, 30) / 30) * 127)
  ];
}

/** Decay is a function of elapsed time, independent of refresh rate. */
export function trailEraseAlpha(seconds, halfLife = 0.65) {
  return 1 - Math.pow(0.5, Math.max(0, seconds) / halfLife);
}

/** Scalar units are already normalized by the source; do not convert twice. */
export function sampleScalar(
  snapshot,
  lon,
  lat,
  kind = snapshot?.scalar?.kind ?? 'speed',
) {
  const grid = snapshot?.grid ?? snapshot;
  if (!grid || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (kind === 'speed') {
    const wind = sampleWind(
      grid === snapshot ? grid : { ...grid, u: snapshot.u, v: snapshot.v },
      lon,
      lat,
    );
    const speed = Math.hypot(wind.u, wind.v);
    return Number.isFinite(speed) ? speed : null;
  }
  const scalar = snapshot.scalar;
  if (
    !WIND_FIELDS[kind] ||
    scalar?.kind !== kind ||
    scalar.units !== WIND_FIELDS[kind].units ||
    !scalar.values
  )
    return null;
  const { nx, ny, lo1, la1, dx, dy } = grid;
  const x = ((normalizeLongitude(lon - lo1) + 360) % 360) / dx;
  const y = clamp((la1 - lat) / dy, 0, ny - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const col = (n) => ((n % nx) + nx) % nx;
  const y1 = Math.min(y0 + 1, ny - 1);
  const a = scalar.values[y0 * nx + col(x0)];
  const b = scalar.values[y0 * nx + col(x0 + 1)];
  const c = scalar.values[y1 * nx + col(x0)];
  const d = scalar.values[y1 * nx + col(x0 + 1)];
  const value =
    (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  return Number.isFinite(value) ? value : null;
}

/** One bounded geographic texture per installed field, never per render frame. */
export function createFieldRaster(snapshot, kind, width = 360, height = 181) {
  const spec = WIND_FIELDS[kind];
  if (
    !spec ||
    !snapshot ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 720 ||
    height > 362
  )
    return null;
  if (
    kind !== 'speed' &&
    (snapshot.scalar?.kind !== kind || snapshot.scalar.units !== spec.units)
  )
    return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const flat = snapshot.grid
    ? {
        ...snapshot.grid,
        u: snapshot.u,
        v: snapshot.v,
        scalar: snapshot.scalar,
      }
    : snapshot;
  let finiteCount = 0;
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      // Pixel centers cover -180..180; the source's 0-degree origin is not an image origin.
      const lon = -180 + ((x + 0.5) / width) * 360;
      const value = sampleScalar(flat, lon, lat, kind);
      if (value === null) continue;
      const t = clamp((value - spec.min) / (spec.max - spec.min), 0, 1);
      const rgb = PALETTES[kind][Math.round(t * 127)];
      const offset = (y * width + x) * 4;
      rgba[offset] = rgb[0];
      rgba[offset + 1] = rgb[1];
      rgba[offset + 2] = rgb[2];
      const alpha =
        kind === 'speed'
          ? 0.22 + 0.43 * Math.sqrt(t)
          : kind === 'pressure'
            ? 0.24 + 0.3 * Math.min(1, Math.abs(value - 1013) / 40)
            : 0.95;
      rgba[offset + 3] = Math.round(255 * alpha);
      finiteCount++;
    }
  }
  return finiteCount ? { width, height, rgba } : null;
}
