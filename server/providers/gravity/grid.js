/**
 * GRACE / GRACE-FO mass-change grids from CSR's RL06.3 mascon release,
 * reduced to one-degree cells for the browser.
 *
 * The source is 0.25° for display only: the mascons are about 1° and the
 * missions resolve roughly 300 km, so a 4 x 4 block mean loses nothing real.
 */

export const GRAVITY_SOURCE = Object.freeze({
  name: 'CSR GRACE/GRACE-FO RL06.3 mascons',
  url: 'https://download.csr.utexas.edu/outgoing/grace/RL0603_mascons/CSR_GRACE_GRACE-FO_RL0603_Mascons_all-corrections.nc',
  page: 'https://www2.csr.utexas.edu/grace/RL06_mascons.html',
  doi: '10.15781/cgq9-nh24',
  credit: 'UT Center for Space Research; GRACE: NASA/DLR; GRACE-FO: NASA/GFZ',
  units: 'cm equivalent water thickness',
  baseline: '2004.000-2009.999 mean removed',
  landMaskUrl:
    'https://download.csr.utexas.edu/outgoing/grace/RL0603_mascons/CSR_GRACE_GRACE-FO_RL06_Mascons_v02_LandMask.nc',
});

/** CSR's land mask grid: 0.25°, kept at full resolution for coastlines. */
export const GRAVITY_LAND_MASK = Object.freeze({ nx: 1440, ny: 720 });

/** One-degree output grid: row 0 is the northernmost row, column 0 starts at 180°W. */
export const GRAVITY_GRID = Object.freeze({
  nx: 360,
  ny: 180,
  lo1: -179.5,
  la1: 89.5,
  dx: 1,
  dy: 1,
});

/** Stored values are signed 16-bit counts of this many centimetres. */
export const GRAVITY_SCALE_CM = 0.5;
export const GRAVITY_NO_DATA = -32768;

const SOURCE_ROWS = 720;
const SOURCE_COLS = 1440;
const FACTOR = 4;
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2002, 0, 1);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Each solution's window, from the file's `time_bounds` (days since
 * 2002-01-01). Solutions are not calendar months: a few overlap (October 2011
 * and April 2015 each have two), so each is keyed by its first day.
 * @param {ArrayLike<number>} bounds Flat [start, end] pairs.
 * @returns {{id: string, start: string, end: string}[]}
 */
export function gravitySolutions(bounds) {
  if (!bounds || bounds.length % 2 !== 0 || bounds.length === 0)
    throw new Error('Invalid gravity time bounds');
  const solutions = [];
  let previous = -Infinity;
  for (let index = 0; index < bounds.length; index += 2) {
    const start = Number(bounds[index]);
    const end = Number(bounds[index + 1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new Error('Invalid gravity time bounds');
    if (start <= previous) throw new Error('Gravity solutions out of order');
    previous = start;
    solutions.push({
      id: isoDay(EPOCH_MS + start * DAY_MS),
      start: isoDay(EPOCH_MS + start * DAY_MS),
      end: isoDay(EPOCH_MS + end * DAY_MS),
    });
  }
  return solutions;
}

/** Confirm the file is on the 0.25° grid this reducer assumes. */
export function assertGravitySourceGrid(lat, lon) {
  const close = (a, b) => Math.abs(a - b) < 1e-3;
  if (
    lat?.length !== SOURCE_ROWS ||
    lon?.length !== SOURCE_COLS ||
    !close(lat[0], -89.875) ||
    !close(lat[SOURCE_ROWS - 1], 89.875) ||
    !close(lon[0], 0.125) ||
    !close(lon[SOURCE_COLS - 1], 359.875)
  )
    throw new Error('Unexpected gravity source grid');
}

/** Centimetres to a stored count; anything non-finite becomes no-data. */
export function quantizeGravity(cm) {
  if (!Number.isFinite(cm)) return GRAVITY_NO_DATA;
  return Math.max(-32767, Math.min(32767, Math.round(cm / GRAVITY_SCALE_CM)));
}

/**
 * Average one block of source cells into the output cube.
 *
 * `values` is a C-order slice [time][row][col] of the source starting at
 * source row `row0` (south first, 0-360 longitude) and column `col0`; rows
 * and columns must start on, and span, whole 4-cell groups. Output rows run
 * north to south and output columns from 180°W, so source column 0 (0.125°E)
 * lands at output column 180.
 * @param {Int16Array} cube Output, [solution][row][col] on GRAVITY_GRID.
 */
export function reduceGravityBlock(
  cube,
  values,
  { time0, times, row0, rows, col0, cols },
) {
  if (
    row0 % FACTOR ||
    rows % FACTOR ||
    col0 % FACTOR ||
    cols % FACTOR ||
    values.length !== times * rows * cols
  )
    throw new Error('Gravity block is not aligned to whole cells');
  const { nx, ny } = GRAVITY_GRID;
  const cellsPerTime = nx * ny;
  for (let t = 0; t < times; t++) {
    const base = t * rows * cols;
    for (let r = 0; r < rows; r += FACTOR) {
      const outRow = ny - 1 - (row0 + r) / FACTOR;
      for (let c = 0; c < cols; c += FACTOR) {
        let sum = 0;
        let count = 0;
        for (let dr = 0; dr < FACTOR; dr++) {
          const offset = base + (r + dr) * cols + c;
          for (let dc = 0; dc < FACTOR; dc++) {
            const value = values[offset + dc];
            if (Number.isFinite(value)) {
              sum += value;
              count++;
            }
          }
        }
        const outCol = ((col0 + c) / FACTOR + 180) % nx;
        cube[(time0 + t) * cellsPerTime + outRow * nx + outCol] = count
          ? quantizeGravity(sum / count)
          : GRAVITY_NO_DATA;
      }
    }
  }
}

/** Output cell for a position, or null off the globe. */
export function gravityCell(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
    return null;
  const { nx, ny } = GRAVITY_GRID;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const row = Math.min(ny - 1, Math.floor(90 - lat));
  const col = Math.min(nx - 1, Math.floor(wrapped + 180));
  return {
    row,
    col,
    lat: GRAVITY_GRID.la1 - row,
    lon: GRAVITY_GRID.lo1 + col,
  };
}

/** Stored count back to centimetres; no-data is null. */
export function gravityValueCm(count) {
  return count === GRAVITY_NO_DATA ? null : count * GRAVITY_SCALE_CM;
}

/**
 * Pack a land mask (one byte per 0.25° cell, row 0 north, column 0 at
 * 180°W, 1 for land) as per-row run lengths: alternating sea and land runs,
 * sea first, LEB128. CSR's mask packs to about 10 KB this way.
 * @param {Uint8Array} mask
 * @returns {Uint8Array}
 */
export function encodeLandMaskRuns(mask) {
  const { nx, ny } = GRAVITY_LAND_MASK;
  if (mask?.length !== nx * ny) throw new Error('Unexpected land mask size');
  const bytes = [];
  const varint = (value) => {
    for (; value > 127; value >>>= 7) bytes.push((value & 127) | 128);
    bytes.push(value);
  };
  for (let row = 0; row < ny; row++) {
    let current = 0;
    let run = 0;
    for (let col = 0; col < nx; col++) {
      const land = mask[row * nx + col] ? 1 : 0;
      if (land === current) run++;
      else {
        varint(run);
        current = land;
        run = 1;
      }
    }
    varint(run);
  }
  return Uint8Array.from(bytes);
}
