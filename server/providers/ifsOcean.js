import { fetchText, fetchRange } from './wind/gfs.js';
import {
  nearestIfsStep,
  parseIfsIndex,
  selectLatestIfsCycle,
} from './wind/ifs.js';
import { coalesceProxyRequest } from './common/http.js';

// Shared by the ocean fields read from ECMWF IFS open data (sea state from
// the `wave` stream, surface currents from `oper`): one global field per
// cycle step, read by byte range, resampled with land masked, and served as
// a small JSON manifest plus a little-endian float32 grid.

/** One global field per cycle step, so the cache needs one entry. */
const CACHE_KEY = 'field';
const TTL_MS = 3600_000;
/** A failed refresh is not retried sooner than this. */
const RETRY_MS = 60_000;
/** An older field is not served, even marked stale. */
const STALE_LIMIT_MS = 24 * 3600_000;
const TIMEOUT_MS = 40_000;
/** The issued grid and the one before it, to cover a manifest/grid rollover. */
const GRID_HISTORY = 2;

/**
 * Resample a north-to-south source grid with missing points onto a global
 * equirectangular grid starting at 0°E, 90°N. Each output point is the
 * bilinear blend of the valid corners around it, reweighted, so a coastal
 * cell is never pulled toward the fill value; with no valid corner it is NaN.
 * @param {{values: ArrayLike<number>, missingValue: number|null, ni: number,
 *   nj: number, lo1: number, la1: number, di: number, dj: number}} field
 * @param {number} dx - Output spacing in degrees, both axes.
 * @param {{min?: number}} [options] - Values below `min` count as missing
 *   (wave height is never negative; a current component often is).
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, values: Float32Array, valid: number, max: number}}
 */
export function resampleMaskedGrid(field, dx, { min = -Infinity } = {}) {
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
    throw new Error('Invalid IFS grid geometry');
  const isValid = (value) =>
    Number.isFinite(value) && value !== missingValue && value >= min;
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dx) + 1;
  const out = new Float32Array(nx * ny);
  let valid = 0;
  let max = -Infinity;
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
  return {
    nx,
    ny,
    lo1: 0,
    la1: 90,
    dx,
    dy: dx,
    values: out,
    valid,
    max: valid ? max : 0,
  };
}

/**
 * Read the named GRIB messages of the newest IFS run that should be posted,
 * falling back one cycle (6 h) once. Six hours after a run its files can
 * still be missing (both streams answered 404 at 6 h 54 min on 2026-10-24),
 * and an index can be posted before its GRIB file is served, so either
 * failure moves to the previous cycle.
 * @param {{urlsFor: (cycle: {date: string, hour: number, step: number}) =>
 *   {grib: string, index: string}, params: string[], fetchImpl: Function,
 *   now: () => number, signal?: AbortSignal}} options
 * @returns {Promise<{cycle: object, messages: Record<string, Uint8Array>}>}
 */
export async function fetchIfsCycleMessages({
  urlsFor,
  params,
  fetchImpl,
  now,
  signal,
}) {
  const nowMs = now();
  for (const lagHours of [6, 12]) {
    const cycle = selectLatestIfsCycle(nowMs, {
      availabilityLagMs: lagHours * 3600_000,
    });
    const runMs = Date.UTC(
      Number(cycle.date.slice(0, 4)),
      Number(cycle.date.slice(4, 6)) - 1,
      Number(cycle.date.slice(6, 8)),
      cycle.hour,
    );
    // The `oper` and `wave` streams publish the same steps (checked
    // 2026-10-24: 3-hourly to f144, then 6-hourly to f360 on 00/12z only).
    const forecastHour = nearestIfsStep((nowMs - runMs) / 3600_000, cycle.hour);
    const urls = urlsFor({ ...cycle, step: forecastHour });
    try {
      const index = parseIfsIndex(
        (await fetchText({ url: urls.index, fetchImpl, signal })).toString(),
      );
      const messages = {};
      for (const param of params) {
        const entry = index.find((item) => item.param === param);
        if (!entry) throw new Error(`missing ${param}`);
        messages[param] = await fetchRange({
          url: urls.grib,
          start: entry.offset,
          end: entry.offset + entry.length - 1,
          fetchImpl,
          signal,
        });
      }
      return {
        cycle: {
          ...cycle,
          forecastHour,
          runIso: new Date(runMs).toISOString(),
          validIso: new Date(runMs + forecastHour * 3600_000).toISOString(),
        },
        messages,
      };
    } catch (error) {
      if (lagHours === 12 || signal?.aborted) throw error;
    }
  }
}

/**
 * A bounded, single-flight, global IFS field route for dev and preview:
 * `<path>` answers a JSON manifest and `<path>/grid/<id>.bin` the grid bytes.
 * A fresh field is served from memory for an hour; a failed refresh waits a
 * minute before the next try and keeps serving the last field, marked stale,
 * for up to a day; with nothing to serve the route answers 502 `errorCode`.
 * @param {{name: string, path: string, errorCode: string,
 *   load: (options: object) => Promise<{cycle: object}>,
 *   describe: (snapshot: object) => object,
 *   gridOf: (snapshot: object) => Float32Array,
 *   fetchImpl?: Function, now?: () => number, decodeImpl?: Function}} options
 */
export function createIfsFieldRoute({
  name,
  path: routePath,
  errorCode,
  load,
  describe,
  gridOf,
  fetchImpl,
  now,
  decodeImpl,
}) {
  const inFlight = new Map();
  const grids = new Map();
  let current = null;
  let lastAttempt = -Infinity;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const snapshot = await load({
        fetchImpl,
        now,
        decodeImpl,
        signal: controller.signal,
      });
      const { cycle } = snapshot;
      const id = `ifs-${cycle.date}-${cycle.hour}-f${cycle.forecastHour}-${snapshot.grid.dx}`;
      const state = { id, snapshot, fetchedAt: now() };
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

  function manifest({ id, snapshot, fetchedAt }, stale) {
    const { grid } = snapshot;
    return {
      schemaVersion: 1,
      source: 'ecmwf-ifs',
      ...describe(snapshot),
      cycle: snapshot.cycle,
      grid: {
        nx: grid.nx,
        ny: grid.ny,
        lo1: grid.lo1,
        la1: grid.la1,
        dx: grid.dx,
        dy: grid.dy,
      },
      ageMs: Math.max(0, now() - fetchedAt),
      stale,
      gridUrl: `${routePath}/grid/${id}.bin`,
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
      const values = gridOf(state.snapshot);
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
        { error: errorCode },
        { 'Retry-After': String(RETRY_MS / 1000) },
      );
    json(
      200,
      manifest(result.state, result.stale),
      result.stale ? { 'X-Data-Stale': 'true' } : {},
    );
  }

  return {
    name,
    configureServer({ middlewares }) {
      middlewares.use(routePath, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(routePath, handler);
    },
  };
}
