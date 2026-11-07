import { coalesceProxyRequest } from './common/http.js';

// Shared by the global gridded fields served as a small JSON manifest plus a
// little-endian float32 grid (sea state, ocean currents).

/** One global field at a time, so the cache needs one entry. */
const CACHE_KEY = 'field';
/** Defaults: an hourly refresh, a day of stale service. */
const TTL_MS = 3600_000;
/** A failed refresh is not retried sooner than this. */
const RETRY_MS = 60_000;
/** An older field is not served, even marked stale. */
const STALE_LIMIT_MS = 24 * 3600_000;
const TIMEOUT_MS = 40_000;
/** The issued grid and the one before it, to cover a manifest/grid rollover. */
const GRID_HISTORY = 2;

/**
 * A bounded, single-flight route for one global gridded field, for dev and
 * preview: `<path>` answers a JSON manifest and `<path>/grid/<id>.bin` the
 * grid bytes. A fresh field is served from memory for `ttlMs`; a failed
 * refresh waits a minute before the next try and keeps serving the last
 * field, marked stale, for up to `staleLimitMs`; with nothing to serve the
 * route answers 502 `errorCode`.
 * @param {{name: string, path: string, errorCode: string, source: string,
 *   gridId: (snapshot: object) => string, ttlMs?: number,
 *   staleLimitMs?: number,
 *   load: (options: object) => Promise<{cycle: object}>,
 *   describe: (snapshot: object) => object,
 *   gridOf: (snapshot: object) => Float32Array,
 *   fetchImpl?: Function, now?: () => number, decodeImpl?: Function}} options
 */
export function createGlobalFieldRoute({
  name,
  path: routePath,
  errorCode,
  source,
  gridId,
  ttlMs = TTL_MS,
  staleLimitMs = STALE_LIMIT_MS,
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
      const id = gridId(snapshot);
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
    if (current && now() - current.fetchedAt < ttlMs)
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
    const kept = current && now() - current.fetchedAt <= staleLimitMs;
    return kept ? { state: current, stale: true } : null;
  }

  function manifest({ id, snapshot, fetchedAt }, stale) {
    const { grid } = snapshot;
    return {
      schemaVersion: 1,
      source,
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
