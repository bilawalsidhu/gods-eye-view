import { sampleMaskedGrid } from '../weather/maskedGrid.js';

/**
 * Surface-current speed stops in m/s, shown as the legend. The texture blends
 * colour and opacity between them, so water hovering near a stop does not
 * break into blocks: it is clear at 0.1 m/s (most of the open ocean, carried
 * by the flow lines alone) and strongest past 1.5 m/s, where boundary
 * currents such as the Gulf Stream, Kuroshio and Agulhas run.
 */
export const CURRENT_SPEED_STOPS = Object.freeze(
  [
    { min: 0.1, color: '#1f5f8b', alpha: 0 },
    { min: 0.25, color: '#2a8dbb', alpha: 0.2 },
    { min: 0.5, color: '#3fbfa8', alpha: 0.45 },
    { min: 1, color: '#e1cf4f', alpha: 0.65 },
    { min: 1.5, color: '#ea7a3d', alpha: 0.8 },
  ].map((stop) => Object.freeze(stop)),
);

const STOP_RGB = CURRENT_SPEED_STOPS.map(({ color }) =>
  color.match(/\w\w/g).map((value) => parseInt(value, 16)),
);

/**
 * RGBA (0–255) for a current speed, blended between the stops, or null for
 * no value (land, no data) and for water at or below the first stop.
 */
export function currentSpeedColor(speed) {
  if (!Number.isFinite(speed) || speed <= CURRENT_SPEED_STOPS[0].min)
    return null;
  const last = CURRENT_SPEED_STOPS.length - 1;
  let i = 0;
  while (i < last && speed > CURRENT_SPEED_STOPS[i + 1].min) i += 1;
  const a = CURRENT_SPEED_STOPS[i];
  const b = CURRENT_SPEED_STOPS[Math.min(last, i + 1)];
  const f = i === last ? 0 : (speed - a.min) / (b.min - a.min);
  const rgb = STOP_RGB[i].map((value, k) =>
    Math.round(value + (STOP_RGB[Math.min(last, i + 1)][k] - value) * f),
  );
  return [...rgb, Math.round(255 * (a.alpha + (b.alpha - a.alpha) * f))];
}

/** Largest grid the route can serve: 0.25° global. */
const MAX_CELLS = 1440 * 721;

/**
 * Validate the route's manifest. Returns null when any field the layer reads
 * is missing or out of range, so a malformed answer is never drawn.
 */
export function parseOceanCurrentsManifest(payload) {
  const grid = payload?.grid;
  const components = payload?.field?.components;
  if (
    payload?.schemaVersion !== 1 ||
    payload.field?.kind !== 'surface-sea-water-velocity' ||
    payload.field.units !== 'm/s' ||
    !Array.isArray(components) ||
    components.join() !== 'u,v' ||
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
    !payload.gridUrl.startsWith('/api/ocean-currents/grid/') ||
    !Number.isFinite(Date.parse(payload.cycle?.runIso)) ||
    !Number.isFinite(Date.parse(payload.cycle?.validIso)) ||
    !Number.isFinite(payload.ageMs) ||
    payload.ageMs < 0
  )
    return null;
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
    runIso: payload.cycle.runIso,
    validIso: payload.cycle.validIso,
    maxSpeed: Number.isFinite(payload.maxSpeed) ? payload.maxSpeed : null,
    ageMs: payload.ageMs,
    stale: payload.stale === true,
  };
}

/**
 * Read the grid's two float32 components (little-endian, u then v, NaN on
 * land). Returns null unless the byte count is exactly both advertised grids.
 * @returns {{u: Float32Array, v: Float32Array}|null}
 */
export function decodeOceanCurrentsGrid(buffer, grid) {
  if (!(buffer instanceof ArrayBuffer) || !grid) return null;
  const count = grid.nx * grid.ny;
  if (buffer.byteLength !== count * 8) return null;
  const view = new DataView(buffer);
  const u = new Float32Array(count);
  const v = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    u[i] = view.getFloat32(i * 4, true);
    v[i] = view.getFloat32((count + i) * 4, true);
  }
  return { u, v };
}

/**
 * The current at a point: eastward and northward m/s, speed, and the compass
 * direction it flows towards (oceanographic convention), or null on land.
 */
export function sampleOceanCurrent(field, lon, lat) {
  const u = sampleMaskedGrid(field?.grid, field?.u, lon, lat);
  const v = sampleMaskedGrid(field?.grid, field?.v, lon, lat);
  if (u === null || v === null) return null;
  const towards = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  return { u, v, speed: Math.hypot(u, v), towards };
}

/**
 * Flow-line sampler for a flat current grid (`nx`…`dy`, `u`, `v`): blends only
 * the sea corners, so baked lines run up to the coast. Writes NaN on land.
 */
export function sampleCurrentVector(field, lon, lat, result = {}) {
  result.u = sampleMaskedGrid(field, field?.u, lon, lat) ?? NaN;
  result.v = sampleMaskedGrid(field, field?.v, lon, lat) ?? NaN;
  return result;
}

/**
 * One geographic texture of current speed for the whole field, pixel centres
 * covering -180..180 and 90..-90. Land, no data and slow water stay
 * transparent. Returns null when nothing would be drawn.
 */
export function createCurrentSpeedRaster(field, width = 720, height = 361) {
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
      const color = currentSpeedColor(
        sampleOceanCurrent(field, lon, lat)?.speed,
      );
      if (!color || color[3] === 0) continue;
      rgba.set(color, (y * width + x) * 4);
      drawn += 1;
    }
  }
  return drawn ? { width, height, rgba } : null;
}
