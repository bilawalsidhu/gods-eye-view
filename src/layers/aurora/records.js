// Pure records for the NOAA SWPC aurora layer: the OVATION probability grid,
// the image drawn from it and the space-weather summary beside it.
// A portable module: no i18n, no renderer.

/** OVATION nodes: whole degrees, longitude 0..359 by latitude -90..90. */
export const OVATION_WIDTH = 360;
export const OVATION_HEIGHT = 181;

/** Probability bands the legend names and the count reports, in percent. */
export const AURORA_BANDS = Object.freeze([10, 30, 50]);

/** Legend colours for those bands (the image's colour at that probability). */
export const AURORA_BAND_COLORS = Object.freeze({
  10: '#2fd67a',
  30: '#7dffb0',
  50: '#ff6fa8',
});

/** Below this probability a pixel is transparent. */
const VISIBLE_FROM = 3;

const finite = (value) =>
  typeof value === 'number' ? value : value === null ? NaN : Number(value);

/** Milliseconds since the epoch of an ISO time, with or without a zone, or null. */
export function parseUtc(text) {
  if (typeof text !== 'string' || !text) return null;
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The OVATION payload as a grid of whole-percent probabilities, row-major by
 * latitude (row 0 is -90°) then longitude (column 0 is 0°E).
 * @returns {{grid: Uint8Array, observedAt: number|null, forecastAt: number|null}}
 */
export function parseOvation(payload) {
  const rows = payload?.coordinates;
  if (
    !Array.isArray(rows) ||
    rows.length < (OVATION_WIDTH * OVATION_HEIGHT) / 2
  )
    throw new Error('Malformed NOAA SWPC response');
  const grid = new Uint8Array(OVATION_WIDTH * OVATION_HEIGHT);
  let accepted = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const lon = Math.round(finite(row[0]));
    const lat = Math.round(finite(row[1]));
    const value = finite(row[2]);
    if (
      !Number.isFinite(value) ||
      !(lon >= 0 && lon < OVATION_WIDTH) ||
      !(lat >= -90 && lat <= 90)
    )
      continue;
    grid[(lat + 90) * OVATION_WIDTH + lon] = Math.max(
      0,
      Math.min(100, Math.round(value)),
    );
    accepted += 1;
  }
  if (accepted < (OVATION_WIDTH * OVATION_HEIGHT) / 2)
    throw new Error('Malformed NOAA SWPC response');
  return {
    grid,
    observedAt: parseUtc(payload['Observation Time']),
    forecastAt: parseUtc(payload['Forecast Time']),
  };
}

/** The probability at a whole-degree node; longitude wraps. */
export function ovationAt(grid, lon, lat) {
  const column = (((Math.round(lon) % 360) + 360) % 360) | 0;
  const row = Math.max(-90, Math.min(90, Math.round(lat))) + 90;
  return grid[row * OVATION_WIDTH + column];
}

/**
 * RGBA for one probability: faint green rising to bright green, then towards
 * the red of high-altitude oxygen emission in the strongest displays.
 * @returns {[number, number, number, number]} 0..255 each.
 */
export function auroraColor(percent) {
  if (!(percent >= VISIBLE_FROM)) return [0, 0, 0, 0];
  const p = Math.min(100, percent);
  // The faint fringe stays a wisp; the oval's core reads as a glow.
  const alpha = Math.round(255 * 0.85 * Math.min(1, p / 30) ** 0.7);
  if (p < 30) {
    const k = (p - VISIBLE_FROM) / (30 - VISIBLE_FROM);
    return [
      Math.round(20 + 105 * k),
      Math.round(180 + 75 * k),
      Math.round(100 + 76 * k),
      alpha,
    ];
  }
  const k = Math.min(1, (p - 30) / 40);
  return [
    Math.round(125 + 130 * k),
    Math.round(255 - 144 * k),
    Math.round(176 - 8 * k),
    alpha,
  ];
}

/**
 * An equirectangular RGBA image of the grid covering longitude -180..180 and
 * latitude 90..-90 (row 0 at the north). Each pixel is a one-degree cell whose
 * value is the mean of its four corner nodes.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function auroraPixels(grid) {
  const width = 360;
  const height = 180;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const north = 90 - y;
    for (let x = 0; x < width; x++) {
      const west = -180 + x;
      const value =
        (ovationAt(grid, west, north) +
          ovationAt(grid, west + 1, north) +
          ovationAt(grid, west, north - 1) +
          ovationAt(grid, west + 1, north - 1)) /
        4;
      const [r, g, b, a] = auroraColor(value);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

/** Nodes at or above each band, as `{10: n, 30: n, 50: n}`. */
export function auroraBandCounts(grid) {
  const counts = Object.fromEntries(AURORA_BANDS.map((band) => [band, 0]));
  for (const value of grid)
    for (const band of AURORA_BANDS) if (value >= band) counts[band] += 1;
  return counts;
}

/**
 * The latitude nearest the equator, per hemisphere, where some longitude has
 * at least `threshold` percent: how far from the poles the aurora reaches
 * overhead. Null for a hemisphere with none.
 * @returns {{north: number|null, south: number|null}}
 */
export function auroraReach(grid, threshold = 10) {
  let north = null;
  let south = null;
  for (let lat = -90; lat <= 90; lat++) {
    const row = (lat + 90) * OVATION_WIDTH;
    let hit = false;
    for (let lon = 0; lon < OVATION_WIDTH && !hit; lon++)
      hit = grid[row + lon] >= threshold;
    if (!hit) continue;
    if (lat >= 0 && (north === null || lat < north)) north = lat;
    if (lat < 0 && (south === null || lat > south)) south = lat;
  }
  return { north, south };
}

/** The latest observed planetary Kp, or null. */
export function parseKp(payload) {
  if (!Array.isArray(payload)) return null;
  for (let i = payload.length - 1; i >= 0; i--) {
    const row = payload[i];
    // The current product is objects; the older one was a header row then arrays.
    const value = finite(Array.isArray(row) ? row[1] : row?.Kp);
    const at = parseUtc(Array.isArray(row) ? row[0] : row?.time_tag);
    if (Number.isFinite(value) && value >= 0 && value <= 9 && at !== null)
      return { value, at };
  }
  return null;
}

const scale = (entry) => {
  const value = Number.parseInt(entry?.Scale, 10);
  return Number.isInteger(value) && value >= 0 && value <= 5 ? value : null;
};

/** Today's NOAA space-weather scales (R radio, S radiation, G geomagnetic), or null. */
export function parseScales(payload) {
  const today = payload?.['0'];
  if (!today || typeof today !== 'object') return null;
  const scales = { r: scale(today.R), s: scale(today.S), g: scale(today.G) };
  return scales.r === null && scales.s === null && scales.g === null
    ? null
    : scales;
}

/** Solar wind speed (km/s) and field (nT) from the SWPC summaries, or null. */
export function parseSolarWind(speedPayload, fieldPayload) {
  const speed = Array.isArray(speedPayload) ? speedPayload[0] : null;
  const field = Array.isArray(fieldPayload) ? fieldPayload[0] : null;
  const speedKms = finite(speed?.proton_speed);
  const bz = finite(field?.bz_gsm);
  const bt = finite(field?.bt);
  const at = parseUtc(speed?.time_tag) ?? parseUtc(field?.time_tag);
  const wind = {
    speedKms: Number.isFinite(speedKms) && speedKms > 0 ? speedKms : null,
    bzNt: Number.isFinite(bz) ? bz : null,
    btNt: Number.isFinite(bt) ? bt : null,
    at,
  };
  return wind.speedKms === null && wind.bzNt === null ? null : wind;
}

/** Where each part of the layer comes from. */
export const AURORA_PROVENANCE = Object.freeze({
  provider: 'NOAA Space Weather Prediction Center',
  model: 'OVATION Prime aurora forecast',
  url: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
  license: 'U.S. Government work (public domain)',
});
