import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  buildFieldPayload as defaultBuildFieldPayload,
  buildGlobalLatticePayload as defaultBuildGlobalLatticePayload,
  tryNormalizeBox,
  boxSpanKm,
} from '../ocean/fieldGrid.js';
import { packFieldManifest } from '../ocean/packField.js';

/** View spans above this (km, longer side) get the cached 1 deg global lattice. */
export const GLOBAL_SPAN_KM = 5000;
/** Cell budget handed to the regional pipeline (HF-radar lattice or HYCOM own axes). */
export const REGIONAL_TARGET_CELLS = 8192;
const GLOBAL_BBOX = Object.freeze({
  latMin: -90,
  latMax: 90,
  lonMin: -180,
  lonMax: 180,
});
const RETRY_MS = 60_000;

/** Snap a box outward to 0.5 deg so panning inside half a degree reuses the field. */
export function quantizeBox(box) {
  const down = (v) => Math.floor(v * 2) / 2;
  const up = (v) => Math.ceil(v * 2) / 2;
  return {
    latMin: Math.max(-90, down(box.latMin)),
    latMax: Math.min(90, up(box.latMax)),
    lonMin: down(box.lonMin),
    lonMax: up(box.lonMax),
  };
}

export function bboxKey(box) {
  return [box.latMin, box.lonMin, box.latMax, box.lonMax]
    .map((v) => v.toFixed(1))
    .join(',');
}

export function gridId({ tier, validIso, key, nx, ny }) {
  const stamp = validIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `currents-${tier}-${stamp}-${key.replace(/[^\w.,-]/g, '_')}-${nx}x${ny}`;
}

/**
 * Serve the surface-current field in the wind layer's manifest + `.bin` shape:
 * `/manifest`, `/status` and `/grid/<id>.bin` under `/api/ocean/currents`.
 * Cached per tier and half-degree box, single-flight per key, stale-served
 * after a failed refresh, with a retry backoff. Mirrors `windProxy`.
 */
export function oceanCurrentsProxy({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  deps = {},
  ttlMs = 600_000,
  staleMs = 6 * 3600_000,
  timeoutMs = 40_000,
  maxCache = 12,
  rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 12, globalMax: 30 }),
} = {}) {
  const buildField = deps.buildFieldPayload ?? defaultBuildFieldPayload;
  const buildGlobal =
    deps.buildGlobalLatticePayload ?? defaultBuildGlobalLatticePayload;
  const caches = new Map(); // key -> { manifest, bytes, fetchedAt }
  const loadings = new Map(); // key -> { promise, waiters, controller }
  const grids = new Map(); // grid id -> bytes (last two per key)
  const gridKeys = new Map(); // key -> [ids]
  const attempts = new Map(); // key -> last attempt ms
  const unavailable = (reason) => ({
    schemaVersion: 1,
    field: 'ocean-currents',
    unavailable: true,
    stale: true,
    reason,
  });
  const sendJson = (res, value, status = 200, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(value));
  };

  function remember(key, state, id) {
    caches.set(key, state);
    if (id) {
      const history = gridKeys.get(key) || [];
      history.push(id);
      while (history.length > 2) grids.delete(history.shift());
      gridKeys.set(key, history);
      grids.set(id, state.bytes);
    }
    while (caches.size > maxCache) {
      const oldest = caches.keys().next().value;
      caches.delete(oldest);
      for (const old of gridKeys.get(oldest) || []) grids.delete(old);
      gridKeys.delete(oldest);
    }
  }

  function refresh(key, tier, box) {
    const controller = new AbortController();
    const operation = { controller, waiters: 0, promise: null };
    loadings.set(key, operation);
    attempts.set(key, now());
    operation.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const atMs = now();
        const payload =
          tier === 'global'
            ? await buildGlobal({ atMs, fetchImpl, deps })
            : await buildField({
                box,
                atMs,
                targetCells: REGIONAL_TARGET_CELLS,
                fetchImpl,
                deps,
              });
        controller.signal.throwIfAborted();
        // The retry backoff guards failures only; a served build may refresh
        // again as soon as its TTL expires.
        attempts.delete(key);
        const fetchedAt = now();
        if (payload.status !== 'ok') {
          // A legitimate answer (open ocean with no source, upstream down):
          // cached like any other so a dead region does not re-probe per move.
          const state = {
            manifest: unavailable(
              payload.reason || 'Ocean current field unavailable',
            ),
            bytes: null,
            fetchedAt,
          };
          remember(key, state, null);
          return state;
        }
        const bbox = tier === 'global' ? GLOBAL_BBOX : box;
        const { manifest, bytes } = packFieldManifest(payload, {
          tier,
          bbox,
          fetchedAt,
          gridUrl: '',
        });
        const id = gridId({
          tier,
          validIso: manifest.cycle.validIso,
          key: tier === 'global' ? 'global' : bboxKey(box),
          nx: manifest.grid.nx,
          ny: manifest.grid.ny,
        });
        manifest.gridUrl = `/api/ocean/currents/grid/${id}.bin`;
        const state = { manifest, bytes, fetchedAt };
        remember(key, state, id);
        return state;
      } catch {
        if (controller.signal.aborted && operation.waiters === 0) {
          attempts.delete(key);
          return {
            manifest: unavailable('Ocean current upstream unavailable'),
            bytes: null,
            fetchedAt: now(),
          };
        }
        const old = caches.get(key);
        if (
          old &&
          !old.manifest.unavailable &&
          now() - old.fetchedAt < staleMs
        ) {
          old.manifest = {
            ...old.manifest,
            stale: true,
            reason: 'Ocean current upstream unavailable',
          };
          return old;
        }
        caches.delete(key);
        return {
          manifest: unavailable('Ocean current upstream unavailable'),
          bytes: null,
          fetchedAt: now(),
        };
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (loadings.get(key) === operation) loadings.delete(key);
      }
    })();
    return operation;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET')
      return sendJson(res, { error: 'method_not_allowed' }, 405);
    if (url.pathname.startsWith('/grid/')) {
      const id = url.pathname.slice(6).replace(/\.bin$/, '');
      const bytes = url.pathname === `/grid/${id}.bin` ? grids.get(id) : null;
      if (!bytes) return sendJson(res, { error: 'unknown_grid' }, 404);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    if (!['/manifest', '/status'].includes(url.pathname))
      return sendJson(res, { error: 'not_found' }, 404);
    if (!rateLimiter(clientKey(req)))
      return sendJson(res, { error: 'Rate limit exceeded' }, 429, {
        'Retry-After': '10',
      });
    // Presence, not finiteness: `Number(null) === 0` would turn an omitted
    // bound into a valid zero. NaN reaches normalizeBox as "not finite".
    const bound = (name) => {
      const raw = url.searchParams.get(name);
      return raw === null ? Number.NaN : Number(raw);
    };
    const { box, error } = tryNormalizeBox({
      latMin: bound('latMin'),
      latMax: bound('latMax'),
      lonMin: bound('lonMin'),
      lonMax: bound('lonMax'),
    });
    if (!box)
      return sendJson(
        res,
        { error: 'Valid latMin/latMax/lonMin/lonMax are required', detail: error },
        400,
      );
    const tier = boxSpanKm(box).maxKm > GLOBAL_SPAN_KM ? 'global' : 'regional';
    const quantized =
      tier === 'global'
        ? GLOBAL_BBOX
        : quantizeBox({
            latMin: box.latMin,
            latMax: box.latMax,
            lonMin: box.lonMin,
            lonMax: box.lonMax,
          });
    const key = tier === 'global' ? 'global' : `regional:${bboxKey(quantized)}`;
    let state = caches.get(key);
    if (!state || now() - state.fetchedAt >= ttlMs) {
      let operation = loadings.get(key);
      if (!operation && now() - (attempts.get(key) ?? -Infinity) >= RETRY_MS)
        operation = refresh(key, tier, quantized);
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
    const manifest =
      state?.manifest || unavailable('Ocean current upstream unavailable');
    if (url.pathname === '/status') {
      const { gridUrl, ...status } = manifest;
      return sendJson(res, status);
    }
    return sendJson(res, manifest);
  };
  return {
    name: 'ocean-currents',
    configureServer({ middlewares }) {
      middlewares.use('/api/ocean/currents', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ocean/currents', handler);
    },
  };
}
