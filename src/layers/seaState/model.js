import { sampleMaskedGrid } from '../weather/maskedGrid.js';

// Imported by the source and by tests without the catalog: band names stay
// English data; the layer translates them as marine terms (index.js).

/**
 * WMO sea-state bands (WMO-No. 306 Manual on Codes, code table 3700, the
 * Douglas scale) by significant wave height in metres. Each band holds
 * heights above its `min` up to and including the next band's `min`: the
 * table assigns an exact bounding height to the lower code (4 m is Rough).
 * Calm water is left transparent so the basemap reads through open, quiet sea.
 */
export const SEA_STATE_BANDS = Object.freeze(
  [
    { code: 1, min: 0, name: 'Calm', color: '#1d3b5a', alpha: 0 },
    { code: 2, min: 0.1, name: 'Smooth', color: '#24618c', alpha: 0.3 },
    { code: 3, min: 0.5, name: 'Slight', color: '#2f8fb0', alpha: 0.45 },
    {
      code: 4,
      min: 1.25,
      name: 'Moderate',
      color: '#4bb8a9',
      alpha: 0.55,
    },
    { code: 5, min: 2.5, name: 'Rough', color: '#a8d36b', alpha: 0.65 },
    {
      code: 6,
      min: 4,
      name: 'Very rough',
      color: '#f2cf4a',
      alpha: 0.72,
    },
    { code: 7, min: 6, name: 'High', color: '#f08a3c', alpha: 0.8 },
    { code: 8, min: 9, name: 'Very high', color: '#d9443a', alpha: 0.85 },
    {
      code: 9,
      min: 14,
      name: 'Phenomenal',
      color: '#9c1f5e',
      alpha: 0.9,
    },
  ].map((band) => Object.freeze(band)),
);

/** The WMO band a height falls in, or null for no value (land, no data). */
export function seaStateBand(metres) {
  if (!Number.isFinite(metres) || metres < 0) return null;
  for (let i = SEA_STATE_BANDS.length - 1; i > 0; i -= 1)
    if (metres > SEA_STATE_BANDS[i].min) return SEA_STATE_BANDS[i];
  return SEA_STATE_BANDS[0];
}

/** Largest grid the route can serve: 0.25° global. */
const MAX_CELLS = 1440 * 721;

/**
 * Validate the route's manifest. Returns null when any field the layer reads
 * is missing or out of range, so a malformed answer is never drawn.
 */
export function parseSeaStateManifest(payload) {
  const grid = payload?.grid;
  if (
    payload?.schemaVersion !== 1 ||
    payload.field?.kind !== 'significant-wave-height' ||
    payload.field.units !== 'm' ||
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
    !payload.gridUrl.startsWith('/api/sea-state/grid/') ||
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
    forecastHour: Number.isInteger(payload.cycle.forecastHour)
      ? payload.cycle.forecastHour
      : null,
    maxValue: Number.isFinite(payload.maxValue) ? payload.maxValue : null,
    ageMs: payload.ageMs,
    stale: payload.stale === true,
  };
}

/**
 * Read the grid's float32 values (little-endian, NaN on land). Returns null
 * unless the byte count is exactly the advertised grid.
 */
export function decodeSeaStateGrid(buffer, grid) {
  if (!(buffer instanceof ArrayBuffer) || !grid) return null;
  const count = grid.nx * grid.ny;
  if (buffer.byteLength !== count * 4) return null;
  const view = new DataView(buffer);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i += 1) values[i] = view.getFloat32(i * 4, true);
  return values;
}

/**
 * Significant wave height at a point: the bilinear blend of the valid grid
 * corners around it, or null on land and off the data.
 */
export function sampleSeaState(field, lon, lat) {
  return sampleMaskedGrid(field?.grid, field?.values, lon, lat);
}

const BAND_RGB = SEA_STATE_BANDS.map(({ color }) =>
  color.match(/\w\w/g).map((value) => parseInt(value, 16)),
);

/**
 * One geographic texture for the whole field, pixel centres covering
 * -180..180 and 90..-90. Land, no data and calm water stay transparent.
 * Returns null when nothing would be drawn.
 */
export function createSeaStateRaster(field, width = 720, height = 361) {
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
      const band = seaStateBand(sampleSeaState(field, lon, lat));
      if (!band || band.alpha === 0) continue;
      const rgb = BAND_RGB[SEA_STATE_BANDS.indexOf(band)];
      const offset = (y * width + x) * 4;
      rgba[offset] = rgb[0];
      rgba[offset + 1] = rgb[1];
      rgba[offset + 2] = rgb[2];
      rgba[offset + 3] = Math.round(255 * band.alpha);
      drawn += 1;
    }
  }
  return drawn ? { width, height, rgba } : null;
}
