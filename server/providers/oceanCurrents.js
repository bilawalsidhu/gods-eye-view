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
  // Bounds a request's wait, not the build: a cold whole-globe HYCOM read
  // can take most of its 60 s fetch timeout before the CoastWatch fallback.
  timeoutMs = 90_000,
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

  /** Drop a key's manifest and its retained grid bodies together. */
  function forget(key) {
    caches.delete(key);
    for (const old of gridKeys.get(key) || []) grids.delete(old);
    gridKeys.delete(key);
  }

  /** Mark a key as most recently used; eviction takes the oldest entry. */
  function touch(key) {
    const state = caches.get(key);
    if (!state) return;
    caches.delete(key);
    caches.set(key, state);
  }

  function remember(key, state, id) {
    caches.delete(key);
    caches.set(key, state);
    if (id) {
      const history = gridKeys.get(key) || [];
      history.push(id);
      while (history.length > 2) grids.delete(history.shift());
      gridKeys.set(key, history);
      grids.set(id, state.bytes);
    }
    while (caches.size > maxCache) forget(caches.keys().next().value);
  }

  /**
   * One build per key. The build always runs to completion and fills the
   * cache (a 10-minute cache fill is worth finishing even when every waiter
   * has gone); the provider timeout only bounds how long a request waits for
   * it, answering stale or unavailable meanwhile.
   */
  function refresh(key, tier, box) {
    attempts.set(key, now());
    const build = (async () => {
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
      const fetchedAt = now();
      if (payload.status !== 'ok') {
        // A regional answer is a legitimate fact about the view (open ocean
        // with no source) and keeps the TTL so a dead region does not re-probe
        // per move; the globe always has a source, so an unavailable globe is
        // an outage and expires with the retry backoff.
        const state = {
          manifest: unavailable(
            payload.reason || 'Ocean current field unavailable',
          ),
          bytes: null,
          fetchedAt,
          expiresAt: fetchedAt + (tier === 'global' ? RETRY_MS : ttlMs),
        };
        remember(key, state, null);
        return state;
      }
      // The global lattice covers the globe; a regional grid is served on
      // its own axes and packField derives its box from the grid extent.
      const { manifest, bytes } = packFieldManifest(payload, {
        tier,
        bbox: tier === 'global' ? GLOBAL_BBOX : null,
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
      const state = {
        manifest,
        bytes,
        fetchedAt,
        expiresAt: fetchedAt + ttlMs,
      };
      remember(key, state, id);
      // The retry backoff guards failures only; a served build may refresh
      // again as soon as its TTL expires.
      attempts.delete(key);
      return state;
    })();
    const settled = build.then(
      () => loadings.delete(key),
      () => loadings.delete(key),
    );
    const operation = {
      promise: (async () => {
        let timer;
        try {
          return await Promise.race([
            build,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Ocean current build timed out')),
                timeoutMs,
              );
            }),
          ]);
        } catch {
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
          if (old) forget(key);
          return {
            manifest: unavailable('Ocean current upstream unavailable'),
            bytes: null,
            fetchedAt: now(),
          };
        } finally {
          clearTimeout(timer);
        }
      })(),
      settled,
    };
    loadings.set(key, operation);
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
      return res.end(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
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
        {
          error: 'Valid latMin/latMax/lonMin/lonMax are required',
          detail: error,
        },
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
    if (state) touch(key);
    if (!state || now() >= (state.expiresAt ?? state.fetchedAt + ttlMs)) {
      let operation = loadings.get(key);
      if (!operation && now() - (attempts.get(key) ?? -Infinity) >= RETRY_MS)
        operation = refresh(key, tier, quantized);
      if (operation) state = await operation.promise;
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
