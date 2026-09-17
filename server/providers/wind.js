import { fetchGfsWind } from './wind/gfs.js';
import { fetchIfsWind } from './wind/ifs.js';
import { decodeWindGribMessage } from './wind/decode.js';
import { weatherScalarMetadata, weatherScalarError } from './wind/grid.js';

/** Serve bounded, single-flight, per-model/overlay forecast snapshots from fixed providers. */
export function windProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  targetDx = 1,
  ttlMs = 3600_000,
  timeoutMs = 40_000,
  models = { gfs: fetchGfsWind, ifs: fetchIfsWind },
} = {}) {
  // Request validation limits these maps to 2 models × 3 overlays.
  const caches = new Map();
  const loadings = new Map();
  const grids = new Map();
  const attempts = new Map();
  const unavailable = (model, overlay) => ({
    manifest: {
      model,
      schemaVersion: 1,
      ...(overlay === 'none' ? {} : { overlay }),
      unavailable: true,
      stale: true,
      reason: 'Wind upstream unavailable',
    },
  });
  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  function refresh(model, overlay, key) {
    const controller = new AbortController();
    const operation = { controller, waiters: 0, promise: null };
    loadings.set(key, operation);
    attempts.set(key, now());
    operation.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await models[model]({
          fetchImpl,
          now,
          decodeImpl,
          targetDx,
          overlay,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        const { grid, cycle } = value;
        const count = grid.nx * grid.ny;
        const expectedScalar = weatherScalarMetadata(overlay);
        const missingScalar =
          expectedScalar &&
          value.scalar === undefined &&
          value.scalarError === weatherScalarError(overlay);
        const scalar = missingScalar ? null : expectedScalar;
        if (
          !Number.isInteger(grid.nx) ||
          !Number.isInteger(grid.ny) ||
          grid.nx < 1 ||
          grid.ny < 1 ||
          count > 1_000_000 ||
          ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
          grid.dx <= 0 ||
          grid.dy <= 0 ||
          (scalar
            ? ['kind', 'units', 'level'].some(
                (field) => value.scalar?.[field] !== scalar[field],
              )
            : value.scalar !== undefined || grid.scalar !== undefined) ||
          (!expectedScalar && value.scalarError !== undefined) ||
          (scalar && value.scalarError !== undefined)
        )
          throw new Error('Invalid wind grid');
        for (const values of [
          grid.u,
          grid.v,
          ...(scalar ? [grid.scalar] : []),
        ]) {
          if (
            !(values instanceof Float32Array) ||
            values.length !== count ||
            !values.every(Number.isFinite)
          )
            throw new Error('Invalid wind grid');
        }
        const suffix =
          overlay === 'none'
            ? ''
            : `-${overlay}${missingScalar ? '-wind-only' : ''}`;
        const query = `model=${model}${overlay === 'none' ? '' : `&overlay=${overlay}`}`;
        const id = `${model}-${cycle.date}-${cycle.hour}-f${cycle.forecastHour || 0}-${targetDx}${suffix}`;
        const manifest = {
          schemaVersion: 1,
          model,
          cycle,
          ...(expectedScalar ? { overlay } : {}),
          ...(scalar ? { scalar } : {}),
          ...(missingScalar
            ? { scalarError: weatherScalarError(overlay) }
            : {}),
          fetchedAt: now(),
          level: value.level,
          units: value.units,
          grid: {
            nx: grid.nx,
            ny: grid.ny,
            lo1: grid.lo1,
            la1: grid.la1,
            dx: grid.dx,
            dy: grid.dy,
          },
          stale: false,
          unavailable: false,
          reason: null,
          gridUrl: `/api/wind/grid/${id}.bin?${query}`,
        };
        const state = { id, grid, manifest, fetchedAt: now() };
        caches.set(key, state);
        // Retain the previous issued grid as well to cover a manifest/grid rollover.
        const history = grids.get(key) || new Map();
        history.set(id, state);
        while (history.size > 2) history.delete(history.keys().next().value);
        grids.set(key, history);
        return state;
      } catch {
        if (controller.signal.aborted && operation.waiters === 0) {
          attempts.delete(key);
          return unavailable(model, overlay);
        }
        const old = caches.get(key);
        if (old) {
          old.manifest = {
            ...old.manifest,
            stale: true,
            reason: 'Wind upstream unavailable',
          };
          return old;
        }
        return unavailable(model, overlay);
      } finally {
        clearTimeout(timer);
        controller.abort(); // Cancel a sibling request if the other component failed.
        if (loadings.get(key) === operation) loadings.delete(key);
      }
    })();
    return operation;
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const model = url.searchParams.get('model') || 'gfs';
    const overlay = url.searchParams.get('overlay') || 'none';
    const key = `${model}:${overlay}`;
    if (req.method !== 'GET')
      return sendJson(res, { error: 'method_not_allowed' }, 405);
    if (!['gfs', 'ifs'].includes(model) || !Object.hasOwn(models, model))
      return sendJson(res, { error: 'unknown_model' }, 400);
    if (!['none', 'temperature', 'pressure'].includes(overlay))
      return sendJson(res, { error: 'unknown_overlay' }, 400);
    if (url.pathname.startsWith('/grid/')) {
      const id = url.pathname.slice(6).replace(/\.bin$/, '');
      const state =
        url.pathname === `/grid/${id}.bin` && grids.get(key)?.get(id);
      if (!state) return sendJson(res, { error: 'unknown_grid' }, 404);
      const components = [
        state.grid.u,
        state.grid.v,
        ...(state.grid.scalar ? [state.grid.scalar] : []),
      ];
      const bytes = Buffer.concat(
        components.map((values) =>
          Buffer.from(values.buffer, values.byteOffset, values.byteLength),
        ),
      );
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(bytes);
    }
    if (!['/', '/manifest', '/status'].includes(url.pathname))
      return sendJson(res, { error: 'not_found' }, 404);
    let state = caches.get(key);
    if (!state || now() - state.fetchedAt >= ttlMs) {
      let operation = loadings.get(key);
      if (!operation && now() - (attempts.get(key) ?? -Infinity) >= 60_000)
        operation = refresh(model, overlay, key);
      if (operation) {
        let disconnected = false;
        operation.waiters += 1;
        const close = () => {
          disconnected = true;
          if (--operation.waiters === 0) operation.controller.abort();
        };
        res.once?.('close', close);
        try {
          state = await operation.promise;
        } finally {
          res.removeListener?.('close', close);
          if (!disconnected) operation.waiters -= 1;
        }
        if (disconnected) return;
      }
    }
    const manifest = state?.manifest || unavailable(model, overlay).manifest;
    if (url.pathname === '/status') {
      const { gridUrl, ...status } = manifest;
      return sendJson(res, status);
    }
    return sendJson(res, manifest);
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
