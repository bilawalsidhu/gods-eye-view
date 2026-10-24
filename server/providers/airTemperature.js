import { createHash } from 'node:crypto';
import { fetchGfsAirTemperature } from './wind/gfs.js';
import { decodeWindGribMessage } from './wind/decode.js';

const UPSTREAM_UNAVAILABLE = 'Air temperature upstream unavailable';
const SCALE = 0.01;

export function encodeAirTemperatureGrid(grid) {
  const count = grid.nx * grid.ny;
  if (
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 1 ||
    grid.ny < 1 ||
    count > 1_000_000 ||
    ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
    grid.dx <= 0 ||
    grid.dy <= 0 ||
    !(grid.scalar instanceof Float32Array) ||
    grid.scalar.length !== count
  )
    throw new Error('Invalid air temperature grid');
  const bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = Math.round(grid.scalar[index] / SCALE);
    if (!Number.isFinite(value) || value < -32768 || value > 32767)
      throw new Error('Invalid air temperature value');
    bytes.writeInt16LE(value, index * 2);
  }
  return bytes;
}

export function airTemperatureProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  targetDx = 1,
  ttlMs = 3600_000,
  timeoutMs = 40_000,
  loadImpl = fetchGfsAirTemperature,
} = {}) {
  let cached;
  let loading;
  let attemptedAt = -Infinity;
  const grids = new Map();
  const unavailable = () => ({
    schemaVersion: 1,
    model: 'gfs',
    level: '2 m above ground',
    units: '°C',
    unavailable: true,
    stale: true,
    reason: UPSTREAM_UNAVAILABLE,
  });
  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  function refresh() {
    const controller = new AbortController();
    const operation = { controller, waiters: 0, promise: null };
    loading = operation;
    attemptedAt = now();
    operation.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await loadImpl({
          fetchImpl,
          now,
          decodeImpl,
          targetDx,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (value.level !== '2 m above ground' || value.units !== '°C')
          throw new Error('Invalid air temperature metadata');
        const { grid, cycle } = value;
        const bytes = encodeAirTemperatureGrid(grid);
        const hash = createHash('sha256')
          .update(bytes)
          .digest('hex')
          .slice(0, 16);
        const id = `gfs-${cycle.date}-${cycle.hour}-f${cycle.forecastHour}-${targetDx}-${hash}`;
        const fetchedAt = now();
        const manifest = {
          schemaVersion: 1,
          model: 'gfs',
          cycle,
          level: value.level,
          units: value.units,
          grid: {
            nx: grid.nx,
            ny: grid.ny,
            lo1: grid.lo1,
            la1: grid.la1,
            dx: grid.dx,
            dy: grid.dy,
            scale: SCALE,
          },
          gridUrl: `/api/air-temperature/grid/${id}.bin`,
          fetchedAt,
          stale: false,
          unavailable: false,
          reason: null,
        };
        cached = { manifest, fetchedAt };
        // Keep one prior issued binary for clients crossing a refresh boundary.
        grids.delete(id);
        grids.set(id, bytes);
        while (grids.size > 2) grids.delete(grids.keys().next().value);
        return manifest;
      } catch {
        if (controller.signal.aborted && operation.waiters === 0) {
          attemptedAt = -Infinity;
          return cached?.manifest ?? unavailable();
        }
        if (cached) {
          cached.manifest = {
            ...cached.manifest,
            stale: true,
            reason: UPSTREAM_UNAVAILABLE,
          };
        }
        return cached?.manifest ?? unavailable();
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (loading === operation) loading = undefined;
      }
    })();
    return operation;
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET')
      return sendJson(res, { error: 'method_not_allowed' }, 405);
    if ((url.searchParams.get('model') || 'gfs') !== 'gfs')
      return sendJson(res, { error: 'unknown_model' }, 400);
    if (url.pathname.startsWith('/grid/')) {
      const id = url.pathname.slice(6).replace(/\.bin$/, '');
      const bytes = url.pathname === `/grid/${id}.bin` && grids.get(id);
      if (!bytes) return sendJson(res, { error: 'unknown_grid' }, 404);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(bytes);
    }
    if (!['/', '/manifest', '/status'].includes(url.pathname))
      return sendJson(res, { error: 'not_found' }, 404);
    let manifest = cached?.manifest;
    if (!cached || now() - cached.fetchedAt >= ttlMs) {
      const operation =
        loading ?? (now() - attemptedAt >= 60_000 ? refresh() : null);
      if (operation) {
        let disconnected = false;
        operation.waiters += 1;
        const close = () => {
          disconnected = true;
          if (--operation.waiters === 0) operation.controller.abort();
        };
        res.once?.('close', close);
        try {
          manifest = await operation.promise;
        } finally {
          res.removeListener?.('close', close);
          if (!disconnected) operation.waiters -= 1;
        }
        if (disconnected) return;
      }
    }
    manifest ??= unavailable();
    if (url.pathname === '/status') {
      const { gridUrl, ...status } = manifest;
      return sendJson(res, status);
    }
    return sendJson(res, manifest);
  };
  return {
    name: 'air-temperature',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-temperature', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-temperature', handler);
    },
  };
}
