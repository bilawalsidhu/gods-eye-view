/**
 * Pure domain model for the AlphaEarth Change layer: the selection box, the
 * year pair, the change grid's wire encoding and its palette. No DOM, no
 * Cesium, no network.
 */

/** The first annual embedding layer the dataset publishes. */
export const ALPHA_EARTH_FIRST_YEAR = 2017;
/** The server refuses boxes with a longer side (upstream reads grow with area). */
export const ALPHA_EARTH_MAX_BOX_KM = 100;
/** `1 − cosine` at which a pixel counts as changed; calibrated on known sites. */
export const ALPHA_EARTH_DEFAULT_THRESHOLD = 0.35;
export const ALPHA_EARTH_DETAILS = Object.freeze(['standard', 'high']);
export const ALPHA_EARTH_ATTRIBUTION =
  'The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.';
export const ALPHA_EARTH_CREDIT = 'AlphaEarth Foundations · Google DeepMind';

/** The server's grid encoding: 0–254 is change × 254, 255 is NoData. */
export const GRID_ENCODING = 'u8-change-254-nodata-255-north-up';
const GRID_SCALE = 254;
const GRID_NODATA = 255;
const KM_PER_DEG_LAT = 111.32;
const LAT_LIMIT = 85;

const toRadians = (deg) => (deg * Math.PI) / 180;
const finite = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value));

/** Box sides in km at the box's middle latitude. */
export function boxSideKm({ west, south, east, north }) {
  const midLat = (south + north) / 2;
  return {
    width: (east - west) * KM_PER_DEG_LAT * Math.cos(toRadians(midLat)),
    height: (north - south) * KM_PER_DEG_LAT,
  };
}

const refuse = (reason, message) => ({ ok: false, reason, message });

/**
 * Validate a degrees box against what the change endpoint accepts.
 * @returns {{ ok: true, box: object } | { ok: false, reason: string, message: string }}
 */
export function validateAlphaEarthBox(box) {
  if (!box || !['west', 'south', 'east', 'north'].every((k) => finite(box[k])))
    return refuse('invalid', 'Box edges must be finite');
  const west = Number(box.west);
  const south = Math.min(Number(box.south), Number(box.north));
  const east = Number(box.east);
  const north = Math.max(Number(box.south), Number(box.north));
  if (Math.abs(west) > 180 || Math.abs(east) > 180)
    return refuse('invalid', 'Longitudes must be within ±180°');
  if (west > east) return refuse('dateline', 'Select one side of the dateline');
  if (Math.abs(south) > LAT_LIMIT || Math.abs(north) > LAT_LIMIT)
    return refuse('polar', `Embeddings stop at ±${LAT_LIMIT}° latitude`);
  if (east === west || north === south)
    return refuse('degenerate', 'Box must enclose an area');
  const { width, height } = boxSideKm({ west, south, east, north });
  const side = Math.max(width, height);
  if (side > ALPHA_EARTH_MAX_BOX_KM)
    return refuse(
      'too-large',
      `Box is ${Math.round(side)} km wide · limit ${ALPHA_EARTH_MAX_BOX_KM} km`,
    );
  return { ok: true, box: { west, south, east, north } };
}

/** Years must be distinct integers from the first published layer; ordered. */
export function normalizeYears(from, to, years = []) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return null;
  if (Math.min(a, b) < ALPHA_EARTH_FIRST_YEAR) return null;
  if (years.length && (!years.includes(a) || !years.includes(b))) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** The default comparison: the earliest full year against the latest. */
export function defaultYears(years) {
  const sorted = [...new Set(years)]
    .filter(Number.isInteger)
    .sort((x, y) => x - y);
  if (sorted.length < 2) return null;
  const from = sorted.find((y) => y > ALPHA_EARTH_FIRST_YEAR) ?? sorted[0];
  const to = sorted[sorted.length - 1];
  return from < to ? { from, to } : { from: sorted[0], to };
}

export function clampThreshold(
  value,
  fallback = ALPHA_EARTH_DEFAULT_THRESHOLD,
) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 1
    ? Math.round(n * 100) / 100
    : fallback;
}

/** Decode the server's base64 grid; null when it does not match its size. */
export function decodeGrid(base64, width, height, atobImpl = globalThis.atob) {
  if (typeof base64 !== 'string' || typeof atobImpl !== 'function') return null;
  let binary;
  try {
    binary = atobImpl(base64);
  } catch {
    return null;
  }
  if (binary.length !== width * height) return null;
  const grid = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) grid[i] = binary.charCodeAt(i);
  return grid;
}

/** Share of valid pixels at or above a threshold, to three decimals. */
export function changedFraction(grid, threshold) {
  const cut = Math.ceil(clampThreshold(threshold) * GRID_SCALE - 1e-9);
  let valid = 0;
  let changed = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const v = grid[i];
    if (v === GRID_NODATA) continue;
    valid += 1;
    if (v >= cut) changed += 1;
  }
  return valid ? Math.round((changed / valid) * 1000) / 1000 : null;
}

/** Palette stops from the threshold (amber) to total change (magenta). */
const LOW = [255, 196, 0];
const HIGH = [255, 0, 128];

/**
 * Colour a change grid into RGBA. Below the threshold and NoData stay
 * transparent, so only change shows over the map.
 * @param {Uint8Array} grid
 * @param {number} threshold 0–1
 * @param {Uint8ClampedArray} [out] width × height × 4
 */
export function colorizeChange(grid, threshold, out) {
  const rgba = out || new Uint8ClampedArray(grid.length * 4);
  const cut = Math.ceil(clampThreshold(threshold) * GRID_SCALE - 1e-9);
  const span = Math.max(1, GRID_SCALE - cut);
  for (let i = 0; i < grid.length; i += 1) {
    const v = grid[i];
    const o = i * 4;
    if (v === GRID_NODATA || v < cut) {
      rgba[o + 3] = 0;
      continue;
    }
    const t = Math.min(1, (v - cut) / span);
    rgba[o] = LOW[0] + (HIGH[0] - LOW[0]) * t;
    rgba[o + 1] = LOW[1] + (HIGH[1] - LOW[1]) * t;
    rgba[o + 2] = LOW[2] + (HIGH[2] - LOW[2]) * t;
    rgba[o + 3] = 150 + 90 * t;
  }
  return rgba;
}

/** CSS gradient matching `colorizeChange`, for the legend. */
export const LEGEND_GRADIENT = `linear-gradient(90deg, rgb(${LOW}), rgb(${HIGH}))`;

/** Box edges are shared as integer degrees × 10 000 (about 11 m). */
const QUANTUM = 10_000;
export const quantizeBox = (box) =>
  box
    ? Object.fromEntries(
        ['west', 'south', 'east', 'north'].map((k) => [
          k,
          Math.round(box[k] * QUANTUM),
        ]),
      )
    : null;
export function dequantizeBox(params) {
  const edges = ['west', 'south', 'east', 'north'];
  if (!edges.every((k) => finite(params?.[k]))) return null;
  return Object.fromEntries(edges.map((k) => [k, Number(params[k]) / QUANTUM]));
}
