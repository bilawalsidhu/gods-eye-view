import { readResponseTextCapped } from './common/http.js';
import { createGlobalFieldRoute } from './globalFieldRoute.js';

// NOAA Coral Reef Watch CoralTemp v3.1 through the NOAA CoastWatch ERDDAP:
// a daily, gap-free, night-only satellite sea surface temperature analysis
// at 0.05°, published a day or two after the night it describes. Keyless;
// everything from 2002 on (NOAA Geo-Polar Blended: reanalysis to 2016, near
// real time since 2017) is free to use with credit to NOAA Coral Reef Watch. ERDDAP serves every 10th cell (0.5°)
// of one day as ESRI ASCII, about 2 MB; land is its nodata value.
const ERDDAP = 'https://coastwatch.noaa.gov/erddap/griddap/noaacrwsstDaily';
/** The dataset's first cell centres; its latitude axis runs south to north. */
const FIRST_LAT = -89.975;
const FIRST_LON = -179.975;
const STRIDE = 10;
const DX = 0.5;
const NX = 720;
const NY = 360;
const MAX_TIME_BYTES = 4 * 1024;
/** 720 × 360 values of up to eight characters each, plus the header. */
const MAX_GRID_BYTES = 4 * 1024 * 1024;
/** The dataset's valid range; anything else counts as missing. */
const VALID_MIN = -2;
const VALID_MAX = 50;
/** Daily data: refresh every three hours, serve the last day for three. */
const TTL_MS = 3 * 3600_000;
const STALE_LIMIT_MS = 72 * 3600_000;

/**
 * ERDDAP URLs: the newest time step, and one day's grid at 0.5°.
 * @param {string} [timeIso] - A time step from the dataset.
 */
export function coralTempUrls(timeIso) {
  const range = (first) => `(${first}):${STRIDE}:(${-first})`;
  return {
    latest: `${ERDDAP}.csv?time${encodeURIComponent('[(last)]')}`,
    grid: `${ERDDAP}.esriAscii?analysed_sst${encodeURIComponent(
      `[(${timeIso})][${range(FIRST_LAT)}][${range(FIRST_LON)}]`,
    )}`,
  };
}

/** The newest time step in ERDDAP's CSV answer (name row, units row, value). */
export function parseLatestTime(text) {
  const value = String(text).trim().split(/\r?\n/)[2]?.trim();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value ?? ''))
    throw new Error('Unexpected sea surface temperature time');
  return new Date(value).toISOString();
}

/**
 * Parse an ESRI ASCII grid into a north-to-south grid of cell centres, with
 * the nodata value and values outside the valid range as NaN.
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, values: Float32Array, valid: number, min: number,
 *   max: number}}
 */
export function parseEsriAsciiGrid(text) {
  const tokens = String(text).trim().split(/\s+/);
  const header = {};
  let i = 0;
  while (i + 1 < tokens.length && /^[a-z_]+$/i.test(tokens[i])) {
    header[tokens[i].toLowerCase()] = Number(tokens[i + 1]);
    i += 2;
  }
  const nx = header.ncols;
  const ny = header.nrows;
  const cell = header.cellsize;
  // Corner origins sit half a cell outside the first centre.
  const west = header.xllcenter ?? header.xllcorner + cell / 2;
  const south = header.yllcenter ?? header.yllcorner + cell / 2;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    nx < 2 ||
    ny < 2 ||
    !(cell > 0) ||
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    tokens.length - i !== nx * ny
  )
    throw new Error('Malformed sea surface temperature grid');
  const nodata = header.nodata_value;
  const values = new Float32Array(nx * ny);
  let valid = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < values.length; k += 1) {
    const value = Number(tokens[i + k]);
    if (Number.isNaN(value))
      throw new Error('Malformed sea surface temperature grid');
    if (value === nodata || value < VALID_MIN || value > VALID_MAX) {
      values[k] = NaN;
      continue;
    }
    values[k] = value;
    valid += 1;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    nx,
    ny,
    lo1: west,
    la1: south + (ny - 1) * cell,
    dx: cell,
    dy: cell,
    values,
    valid,
    min: valid ? min : 0,
    max: valid ? max : 0,
  };
}

async function getText(url, maxBytes, fetchImpl, signal) {
  const response = await fetchImpl(url, { signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CoralTemp HTTP ${response.status}`);
  }
  return readResponseTextCapped(response, maxBytes, signal);
}

/**
 * Fetch the newest CoralTemp day at 0.5°. The grid must have exactly the
 * requested geometry, or it is refused.
 * @param {{fetchImpl?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<{cycle: {date: string, validIso: string}, grid: object}>}
 */
export async function fetchCoralTempSst({ fetchImpl = fetch, signal } = {}) {
  const validIso = parseLatestTime(
    await getText(coralTempUrls().latest, MAX_TIME_BYTES, fetchImpl, signal),
  );
  const grid = parseEsriAsciiGrid(
    await getText(
      coralTempUrls(validIso.replace('.000Z', 'Z')).grid,
      MAX_GRID_BYTES,
      fetchImpl,
      signal,
    ),
  );
  if (
    grid.nx !== NX ||
    grid.ny !== NY ||
    grid.dx !== DX ||
    Math.abs(grid.lo1 - FIRST_LON) > 1e-3 ||
    Math.abs(grid.la1 - (FIRST_LAT + (NY - 1) * DX)) > 1e-3
  )
    throw new Error('Unexpected sea surface temperature grid');
  if (!grid.valid) throw new Error('Empty sea surface temperature field');
  grid.lo1 = FIRST_LON;
  grid.la1 = FIRST_LAT + (NY - 1) * DX;
  return {
    cycle: { date: validIso.slice(0, 10).replaceAll('-', ''), validIso },
    grid,
  };
}

/** Bounded, single-flight, global sea surface temperature for dev and preview. */
export function seaSurfaceTemperatureProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  load = fetchCoralTempSst,
} = {}) {
  const round = (value) => Math.round(value * 100) / 100;
  return createGlobalFieldRoute({
    name: 'sea-surface-temperature',
    path: '/api/sea-surface-temperature',
    errorCode: 'sea_surface_temperature_unavailable',
    source: 'noaa-crw-coraltemp',
    gridId: ({ cycle, grid }) => `crw-${cycle.date}-${grid.dx}`,
    ttlMs: TTL_MS,
    staleLimitMs: STALE_LIMIT_MS,
    load,
    describe: ({ grid }) => ({
      field: { kind: 'sea-surface-temperature', units: 'degC' },
      oceanCells: grid.valid,
      minValue: round(grid.min),
      maxValue: round(grid.max),
    }),
    gridOf: ({ grid }) => grid.values,
    fetchImpl,
    now,
  });
}
