import { sampleMaskedGrid } from '../weather/maskedGrid.js';

/**
 * Sea surface temperature stops in °C, shown as the legend. The texture
 * blends between them. Sea spans about -2 to 32 °C, so the ramp spends its
 * whole range there instead of reusing the wind layer's -40 to 50 °C air
 * scale, where the ocean would collapse into a few hues and fronts such as
 * the Gulf Stream wall would not show. Every sea cell is drawn; land is clear.
 */
export const SST_STOPS = Object.freeze(
  [
    { min: -2, color: '#3b2a7a' },
    { min: 3, color: '#2f5fbf' },
    { min: 8, color: '#2a95cf' },
    { min: 13, color: '#3fc1c0' },
    { min: 18, color: '#8ad49a' },
    { min: 22, color: '#e8d454' },
    { min: 26, color: '#f09a3a' },
    { min: 29, color: '#dd5236' },
    { min: 32, color: '#9f274d' },
  ].map((stop) => Object.freeze(stop)),
);

const SST_ALPHA = 0.75;

const STOP_RGB = SST_STOPS.map(({ color }) =>
  color.match(/\w\w/g).map((value) => parseInt(value, 16)),
);

/**
 * RGBA (0–255) for a temperature, blended between the stops and held at the
 * ends, or null for no value (land, no data).
 */
export function seaSurfaceTemperatureColor(celsius) {
  if (!Number.isFinite(celsius)) return null;
  const last = SST_STOPS.length - 1;
  let i = 0;
  while (i < last && celsius > SST_STOPS[i + 1].min) i += 1;
  const next = Math.min(last, i + 1);
  const f =
    i === last
      ? 0
      : Math.max(
          0,
          (celsius - SST_STOPS[i].min) /
            (SST_STOPS[next].min - SST_STOPS[i].min),
        );
  return [
    ...STOP_RGB[i].map((value, k) =>
      Math.round(value + (STOP_RGB[next][k] - value) * f),
    ),
    Math.round(255 * SST_ALPHA),
  ];
}

/** Largest grid the route can serve: 0.25° global. */
const MAX_CELLS = 1440 * 721;

/**
 * Validate the route's manifest. Returns null when any field the layer reads
 * is missing or out of range, so a malformed answer is never drawn.
 */
export function parseSeaSurfaceTemperatureManifest(payload) {
  const grid = payload?.grid;
  if (
    payload?.schemaVersion !== 1 ||
    payload.field?.kind !== 'sea-surface-temperature' ||
    payload.field.units !== 'degC' ||
    !grid ||
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 2 ||
    grid.ny < 2 ||
    grid.nx * grid.ny > MAX_CELLS ||
    ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
    grid.dx <= 0 ||
    grid.dy <= 0 ||
    typeof payload.gridUrl !== 'string' ||
    !payload.gridUrl.startsWith('/api/sea-surface-temperature/grid/') ||
    !Number.isFinite(Date.parse(payload.cycle?.validIso)) ||
    !Number.isFinite(payload.ageMs) ||
    payload.ageMs < 0
  )
    return null;
  const finite = (value) => (Number.isFinite(value) ? value : null);
  return {
    grid: {
      nx: grid.nx,
      ny: grid.ny,
      lo1: grid.lo1,
      la1: grid.la1,
      dx: grid.dx,
      dy: grid.dy,
    },
    gridUrl: payload.gridUrl,
    validIso: payload.cycle.validIso,
    minValue: finite(payload.minValue),
    maxValue: finite(payload.maxValue),
    ageMs: payload.ageMs,
    stale: payload.stale === true,
  };
}

/**
 * Read the grid's float32 values (little-endian, NaN on land). Returns null
 * unless the byte count is exactly the advertised grid.
 */
export function decodeSeaSurfaceTemperatureGrid(buffer, grid) {
  if (!(buffer instanceof ArrayBuffer) || !grid) return null;
  const count = grid.nx * grid.ny;
  if (buffer.byteLength !== count * 4) return null;
  const view = new DataView(buffer);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i += 1) values[i] = view.getFloat32(i * 4, true);
  return values;
}

/**
 * Sea surface temperature at a point in °C: the bilinear blend of the valid
 * grid corners around it, or null on land and off the data.
 */
export function sampleSeaSurfaceTemperature(field, lon, lat) {
  return sampleMaskedGrid(field?.grid, field?.values, lon, lat);
}

/**
 * One geographic texture for the whole field, pixel centres covering
 * -180..180 and 90..-90. Land and no data stay transparent. Returns null
 * when nothing would be drawn.
 */
export function createSeaSurfaceTemperatureRaster(
  field,
  width = 720,
  height = 361,
) {
  if (
    !field?.grid ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 1440 ||
    height > 721
  )
    return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let drawn = 0;
  for (let y = 0; y < height; y += 1) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x += 1) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      const color = seaSurfaceTemperatureColor(
        sampleSeaSurfaceTemperature(field, lon, lat),
      );
      if (!color) continue;
      rgba.set(color, (y * width + x) * 4);
      drawn += 1;
    }
  }
  return drawn ? { width, height, rgba } : null;
}
