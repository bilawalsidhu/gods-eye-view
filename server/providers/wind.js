import { fetchGfsWind } from './wind/gfs.js';
import { fetchIfsWind } from './wind/ifs.js';
import { decodeWindGribMessage } from './wind/decode.js';

/**
 * Return whether every value in a resampled grid is finite. A decode that
 * yields NaN/Infinity must never be cached or served as a valid wind field.
 * @param {{u: Float32Array, v: Float32Array}} grid
 * @returns {boolean}
 */
function gridIsFinite(grid) {
  for (const array of [grid.u, grid.v]) {
    for (let i = 0; i < array.length; i += 1)
      if (!Number.isFinite(array[i])) return false;
  }
  return true;
}

/**
 * GFS/IFS 10 m wind proxy.
 *
 * Dispatches by `?model=gfs|ifs` (default gfs), caches each model's latest
 * cycle for an hour (single-flight, last-good on failure), and serves a
 * manifest plus a Float32 grid (U values then V values).
 *
 * Routes (mounted at `/api/wind`):
 *   GET /api/wind/manifest?model=…   → manifest JSON
 *   GET /api/wind/grid/<id>.bin?model=… → Float32 U…V payload
 *   GET /api/wind/status?model=…     → manifest without `gridUrl`
 *
 * @param {{fetchImpl?: Function, now?: Function, decodeImpl?: Function,
 *   targetDx?: number, ttlMs?: number, models?: object}} [options]
 * @returns {import('vite').Plugin}
 */
export function windProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  targetDx = 1,
  ttlMs = 3600_000,
  models = { gfs: fetchGfsWind, ifs: fetchIfsWind },
} = {}) {
  /** @type {Map<string, object>} */
  const caches = new Map();
  /** @type {Map<string, Promise<object>>} */
  const loadings = new Map();

  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };

  const refresh = (model) => {
    const loader = models[model];
    const options = { fetchImpl, now, decodeImpl, targetDx };
    const promise = (async () => {
      try {
        const value = await loader(options);
        if (!gridIsFinite(value.grid))
          throw new Error('wind grid contains non-finite values');
        // The model is part of both the id and the URL: two models can share a
        // cycle, and the grid route must resolve to the requesting model.
        const idGrid = `${model}-${value.cycle.date}-${value.cycle.hour}-${targetDx}`;
        const manifest = {
          schemaVersion: 1,
          model,
          cycle: value.cycle,
          fetchedAt: now(),
          level: value.level,
          units: value.units,
          grid: {
            nx: value.grid.nx,
            ny: value.grid.ny,
            lo1: value.grid.lo1,
            la1: value.grid.la1,
            dx: value.grid.dx,
            dy: value.grid.dy,
          },
          stale: false,
          unavailable: false,
          reason: null,
          gridUrl: `/api/wind/grid/${idGrid}.bin?model=${model}`,
        };
        const state = {
          idGrid,
          fetchedAt: manifest.fetchedAt,
          manifest,
          grid: value.grid,
        };
        caches.set(model, state);
        return state;
      } catch (error) {
        const old = caches.get(model);
        if (old) {
          old.manifest = {
            ...old.manifest,
            stale: true,
            reason: error.message,
          };
          return old;
        }
        return {
          idGrid: null,
          grid: null,
          manifest: {
            schemaVersion: 1,
            model,
            stale: true,
            unavailable: true,
            reason: error.message,
          },
        };
      } finally {
        loadings.delete(model);
      }
    })();
    loadings.set(model, promise);
    return promise;
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const model = url.searchParams.get('model') || 'gfs';
    if (!models[model]) return sendJson(res, { error: 'unknown_model' }, 400);
    let state = caches.get(model);
    if (!state || now() - state.fetchedAt >= ttlMs)
      state = loadings.get(model) || refresh(model);
    state = await state;
    if (url.pathname === '/status') {
      const { gridUrl, ...manifest } = state.manifest;
      return sendJson(res, manifest);
    }
    if (url.pathname.startsWith('/grid/')) {
      if (!state.grid || url.pathname !== `/grid/${state.idGrid}.bin`)
        return sendJson(res, { error: 'unknown_grid' }, 404);
      const payload = Buffer.concat([
        Buffer.from(
          state.grid.u.buffer,
          state.grid.u.byteOffset,
          state.grid.u.byteLength,
        ),
        Buffer.from(
          state.grid.v.buffer,
          state.grid.v.byteOffset,
          state.grid.v.byteLength,
        ),
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(payload);
    }
    return sendJson(res, state.manifest);
  };

  return {
    name: 'wind',
    configureServer({ middlewares }) {
      middlewares.use('/api/wind', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wind', handler);
    },
  };
}
