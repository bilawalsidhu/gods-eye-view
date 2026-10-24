import { fetchText, fetchRange } from './wind/gfs.js';
import { decodeWindGribMessage } from './wind/decode.js';
import {
  nearestIfsStep,
  parseIfsIndex,
  selectLatestIfsCycle,
} from './wind/ifs.js';
import { coalesceProxyRequest } from './common/http.js';

// ECMWF IFS open data, wave stream: significant height of combined wind waves
// and swell (`swh`, metres) on the same 0.25° grid and cycles as the `oper`
// fields the wind layer reads. CC BY 4.0, keyless. Land has no value: the
// message carries a bitmap and ecCodes fills those points with missingValue.
const IFS_BASE = 'https://data.ecmwf.int/forecasts';
/** One global field per cycle step, so the cache needs one entry. */
const CACHE_KEY = 'swh';
const TTL_MS = 3600_000;
/** A failed refresh is not retried sooner than this. */
const RETRY_MS = 60_000;
/** An older field is not served, even marked stale. */
const STALE_LIMIT_MS = 24 * 3600_000;
const TIMEOUT_MS = 40_000;
/** 0.5° keeps coastlines readable and the grid at 720 × 361 floats (~1 MB). */
const TARGET_DX = 0.5;
/** The issued grid and the one before it, to cover a manifest/grid rollover. */
const GRID_HISTORY = 2;

/**
 * IFS wave-stream GRIB2 and `.index` URLs for one cycle and step.
 * @param {{date: string, hour: number, step?: number}} cycle
 * @returns {{grib: string, index: string}}
 */
export function ifsWaveObjectUrls({ date, hour, step = 0 }) {
  const hh = String(hour).padStart(2, '0');
  const stem = `${IFS_BASE}/${date}/${hh}z/ifs/0p25/wave/${date}${hh}0000-${step}h-wave-fc`;
  return { grib: `${stem}.grib2`, index: `${stem}.index` };
}

/**
 * Resample a north-to-south source grid with missing points onto a global
 * equirectangular grid starting at 0°E, 90°N. Each output point is the
 * bilinear blend of the valid corners around it, reweighted, so a coastal
 * cell is never pulled toward the fill value; with no valid corner it is NaN.
 * @param {{values: ArrayLike<number>, missingValue: number|null, ni: number,
 *   nj: number, lo1: number, la1: number, di: number, dj: number}} field
 * @param {number} [dx] - Output spacing in degrees, both axes.
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, values: Float32Array, valid: number, max: number}}
 */
export function resampleMaskedGrid(field, dx = TARGET_DX) {
  const { values, missingValue, ni, nj, lo1, la1, di, dj } = field ?? {};
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 2 ||
    nj < 2 ||
    ni * nj > 2_000_000 ||
    values?.length !== ni * nj ||
    ![lo1, la1, di, dj, dx].every(Number.isFinite) ||
    di <= 0 ||
    dj <= 0 ||
    dx < 0.25 ||
    dx > 90 ||
    (missingValue !== null && !Number.isFinite(missingValue))
  )
    throw new Error('Invalid sea-state grid geometry');
  const isValid = (value) =>
    Number.isFinite(value) && value !== missingValue && value >= 0;
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dx) + 1;
  const out = new Float32Array(nx * ny);
  let valid = 0;
  let max = 0;
  for (let y = 0; y < ny; y += 1) {
    const lat = 90 - y * dx;
    const sy = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const y0 = Math.floor(sy);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < nx; x += 1) {
      const sx = ((((x * dx - lo1) / di) % ni) + ni) % ni;
      const x0 = Math.floor(sx);
      const x1 = (x0 + 1) % ni;
      const fx = sx - x0;
      let sum = 0;
      let weight = 0;
      for (const [index, w] of [
        [y0 * ni + x0, (1 - fx) * (1 - fy)],
        [y0 * ni + x1, fx * (1 - fy)],
        [y1 * ni + x0, (1 - fx) * fy],
        [y1 * ni + x1, fx * fy],
      ]) {
        if (w > 0 && isValid(values[index])) {
          sum += values[index] * w;
          weight += w;
        }
      }
      const value = weight > 0 ? sum / weight : NaN;
      out[y * nx + x] = value;
      if (weight > 0) {
        valid += 1;
        if (value > max) max = value;
      }
    }
  }
  return { nx, ny, lo1: 0, la1: 90, dx, dy: dx, values: out, valid, max };
}

/**
 * Fetch and decode the IFS significant wave height valid closest to now.
 * @param {{fetchImpl?: Function, now?: Function, decodeImpl?: Function,
 *   signal?: AbortSignal, targetDx?: number}} [options]
 */
export async function fetchIfsWaveHeight({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  signal,
  targetDx = TARGET_DX,
} = {}) {
  const nowMs = now();
  // Six hours after a run its files can still be missing (both streams
  // answered 404 at 6 h 54 min on 2026-10-24), so fall back one cycle once.
  let cycle;
  let runMs;
  let forecastHour;
  let urls;
  let index;
  for (const lagHours of [6, 12]) {
    cycle = selectLatestIfsCycle(nowMs, {
      availabilityLagMs: lagHours * 3600_000,
    });
    runMs = Date.UTC(
      Number(cycle.date.slice(0, 4)),
      Number(cycle.date.slice(4, 6)) - 1,
      Number(cycle.date.slice(6, 8)),
      cycle.hour,
    );
    // The wave stream publishes the same steps as `oper` (checked 2026-10-24:
    // 3-hourly to f144, then 6-hourly to f360 on 00/12z only).
    forecastHour = nearestIfsStep((nowMs - runMs) / 3600_000, cycle.hour);
    urls = ifsWaveObjectUrls({ ...cycle, step: forecastHour });
    try {
      index = await fetchText({ url: urls.index, fetchImpl, signal });
      break;
    } catch (error) {
      if (lagHours === 12 || signal?.aborted) throw error;
    }
  }
  const entry = parseIfsIndex(index.toString()).find(
    (item) => item.param === 'swh',
  );
  if (!entry) throw new Error('missing swh');
  const field = await decodeImpl(
    await fetchRange({
      url: urls.grib,
      start: entry.offset,
      end: entry.offset + entry.length - 1,
      fetchImpl,
      signal,
    }),
  );
  signal?.throwIfAborted();
  if (field?.shortName !== 'swh' || field.units !== 'm')
    throw new Error('Unexpected sea-state field');
  const grid = resampleMaskedGrid(field, targetDx);
  if (!grid.valid) throw new Error('Empty sea-state field');
  return {
    cycle: {
      ...cycle,
      forecastHour,
      runIso: new Date(runMs).toISOString(),
      validIso: new Date(runMs + forecastHour * 3600_000).toISOString(),
    },
    grid,
  };
}

/** Bounded, single-flight, global significant-wave-height snapshot for dev and preview. */
export function seaStateProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  load = fetchIfsWaveHeight,
} = {}) {
  const inFlight = new Map();
  const grids = new Map();
  let current = null;
  let lastAttempt = -Infinity;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const { cycle, grid } = await load({
        fetchImpl,
        now,
        decodeImpl,
        signal: controller.signal,
      });
      const id = `ifs-${cycle.date}-${cycle.hour}-f${cycle.forecastHour}-${grid.dx}`;
      const state = { id, cycle, grid, fetchedAt: now() };
      grids.set(id, state);
      while (grids.size > GRID_HISTORY) grids.delete(grids.keys().next().value);
      current = state;
      return state;
    } finally {
      clearTimeout(timer);
    }
  }

  async function acquire() {
    if (current && now() - current.fetchedAt < TTL_MS)
      return { state: current, stale: false };
    // Join a refresh already running; start one only outside the retry gap.
    if (inFlight.has(CACHE_KEY) || now() - lastAttempt >= RETRY_MS) {
      try {
        const { promise } = coalesceProxyRequest(inFlight, CACHE_KEY, () => {
          lastAttempt = now();
          return refresh();
        });
        return { state: await promise, stale: false };
      } catch {
        /* fall through to the last good field */
      }
    }
    const kept = current && now() - current.fetchedAt <= STALE_LIMIT_MS;
    return kept ? { state: current, stale: true } : null;
  }

  function manifest({ id, cycle, grid, fetchedAt }, stale) {
    return {
      schemaVersion: 1,
      source: 'ecmwf-ifs',
      field: { kind: 'significant-wave-height', units: 'm' },
      cycle,
      grid: {
        nx: grid.nx,
        ny: grid.ny,
        lo1: grid.lo1,
        la1: grid.la1,
        dx: grid.dx,
        dy: grid.dy,
      },
      oceanCells: grid.valid,
      maxValue: Math.round(grid.max * 100) / 100,
      ageMs: Math.max(0, now() - fetchedAt),
      stale,
      gridUrl: `/api/sea-state/grid/${id}.bin`,
    };
  }

  async function handler(req, res) {
    const json = (status, value, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...extra,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path.startsWith('/grid/')) {
      const match = /^\/grid\/([\w.-]+)\.bin$/.exec(path);
      const state = match && grids.get(match[1]);
      if (!state) return json(404, { error: 'unknown_grid' });
      const { values } = state.grid;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(
        Buffer.from(values.buffer, values.byteOffset, values.byteLength),
      );
    }
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const result = await acquire();
    if (!result)
      return json(
        502,
        { error: 'sea_state_unavailable' },
        { 'Retry-After': String(RETRY_MS / 1000) },
      );
    json(
      200,
      manifest(result.state, result.stale),
      result.stale ? { 'X-Data-Stale': 'true' } : {},
    );
  }

  return {
    name: 'sea-state',
    configureServer({ middlewares }) {
      middlewares.use('/api/sea-state', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sea-state', handler);
    },
  };
}
