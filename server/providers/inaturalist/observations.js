import { createInatClient } from './client.js';
import { coalesceProxyRequest } from '../common/http.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { requiredFiniteQueryNumber } from '../common/query.js';
import { snapWildlifeBox } from '../../../src/layers/wildlifeSightings/bounds.js';
import { validInatGridTile } from './grid.js';

// The upstream advertises five-minute freshness; global samples cost less often.
const TTL_MS = 300_000;
const GLOBAL_TTL_MS = 600_000;
const INAT_GRID_CACHE_TTL_MS = 15 * 60_000;
const STALE_MAX_MS = 3_600_000;
const INAT_CACHE_MAX = 400;
const HOUR_MS = 3_600_000;
const TAXA = Object.freeze([
  'all',
  'Aves',
  'Mammalia',
  'Insecta',
  'Plantae',
  'whales',
]);

function requestParams(pathname, query, nowMs) {
  const grid = pathname === '/grid';
  const scope = grid ? 'grid' : (query.get('scope') ?? 'view');
  if (!grid && scope !== 'view' && scope !== 'global')
    return { error: 'invalid_scope' };
  const quality =
    query.get('quality') === 'research' ||
    (grid && query.get('confirmed') === 'true')
      ? 'research'
      : 'all';
  const taxa = TAXA.includes(query.get('taxa')) ? query.get('taxa') : 'all';
  let box = null;
  let tile;
  if (grid) {
    tile = Object.fromEntries(
      ['z', 'x', 'y'].map((name) => [
        name,
        requiredFiniteQueryNumber(query, name),
      ]),
    );
    if (!validInatGridTile(tile)) return { error: 'invalid_tile' };
  } else if (scope === 'view') {
    const south = requiredFiniteQueryNumber(query, 'south');
    const west = requiredFiniteQueryNumber(query, 'west');
    const north = requiredFiniteQueryNumber(query, 'north');
    const east = requiredFiniteQueryNumber(query, 'east');
    box = snapWildlifeBox({ south, west, north, east });
    if (!box) return { error: 'invalid_bbox' };
  }
  const windowMs = (taxa === 'whales' ? 7 * 24 : 48) * HOUR_MS;
  const windowKey = new Date(Math.floor((nowMs - windowMs) / HOUR_MS) * HOUR_MS)
    .toISOString()
    .replace('.000Z', 'Z');
  const bounds = box ? `${box.south},${box.west},${box.north},${box.east}` : '';
  const baseKey = grid
    ? `grid:v1:${tile.z}/${tile.x}/${tile.y}:${quality}:${taxa}`
    : `v1:${scope}:${bounds}:${quality}:${taxa}`;
  return {
    scope,
    ...(grid
      ? { ...tile, waitForFresh: query.get('refresh') === 'wait' }
      : { box }),
    quality,
    taxa,
    observedD1: windowKey.slice(0, 10),
    baseKey,
    key: `${baseKey}:${windowKey}`,
  };
}

/** A shared-provider route for dev and preview; acquisition starts on demand. */
export function inaturalistProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir,
  cache = new Map(),
  warn = (...args) => console.warn(...args),
  queueOptions,
} = {}) {
  const inFlight = new Map();
  const consumers = new Map();
  let client = null;

  function age(entry) {
    if (!entry) return Infinity;
    const elapsed = now() - entry.savedAt;
    return elapsed < 0 ? Infinity : elapsed;
  }

  function joinFlight(promise, group, signal) {
    group.count += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      function release() {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', abort);
        group.count -= 1;
        if (!group.count && !group.background && !group.settled) {
          group.controller.abort();
          // A fresh consumer must not join an abandoned queued generation.
          if (inFlight.get(group.key) === promise) inFlight.delete(group.key);
          if (consumers.get(group.key) === group) consumers.delete(group.key);
        }
      }
      function abort() {
        release();
        reject(signal.reason);
      }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      promise.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    });
  }

  function refresh(params, background = false) {
    // Global samples share pending refreshes across hourly window changes.
    const flightKey = params.scope === 'global' ? params.baseKey : params.key;
    let group = consumers.get(flightKey);
    if (!group) {
      group = {
        key: flightKey,
        controller: new AbortController(),
        count: 0,
        settled: false,
        background,
      };
      consumers.set(flightKey, group);
    }
    group.background ||= background;
    const { promise, shared } = coalesceProxyRequest(
      inFlight,
      flightKey,
      async () => {
        client ??= createInatClient({
          fetchImpl,
          now,
          cacheDir,
          warn,
          queueOptions,
        });
        const options = { signal: group.controller.signal };
        const result = await (params.scope === 'grid'
          ? client.getGrid(params, options)
          : client.getObservations(params, options));
        const value = {
          fetchedAt: now(),
          ...(params.scope === 'grid'
            ? {}
            : { scope: params.scope, box: params.box }),
          ...result,
        };
        cache.delete(params.key);
        cache.set(params.key, {
          value,
          savedAt: now(),
          baseKey: params.baseKey,
        });
        while (cache.size > INAT_CACHE_MAX)
          cache.delete(cache.keys().next().value);
        return value;
      },
    );
    if (!shared) {
      const settle = () => {
        group.settled = true;
        if (consumers.get(flightKey) === group) consumers.delete(flightKey);
      };
      void promise.then(settle, settle);
    }
    return { promise, group };
  }

  async function acquire(params, signal) {
    signal?.throwIfAborted();
    for (const [key, entry] of cache) {
      if (age(entry) > STALE_MAX_MS) cache.delete(key);
    }
    const current = cache.get(params.key);
    const ttl =
      params.scope === 'grid'
        ? INAT_GRID_CACHE_TTL_MS
        : params.scope === 'global'
          ? GLOBAL_TTL_MS
          : TTL_MS;
    if (current && age(current) < ttl) {
      cache.delete(params.key);
      cache.set(params.key, current);
      return { value: current.value, stale: false };
    }
    // Window-hour rollover can reuse prior cells without claiming a new age.
    let previous = current;
    let previousKey = params.key;
    if (!previous) {
      for (const [key, entry] of cache) {
        if (
          entry.baseKey === params.baseKey &&
          (!previous || entry.savedAt > previous.savedAt)
        ) {
          previous = entry;
          previousKey = key;
        }
      }
    }
    if (params.scope === 'global' && age(previous) < GLOBAL_TTL_MS)
      return { value: previous.value, stale: false };
    if (
      params.scope === 'grid' &&
      !params.waitForFresh &&
      age(previous) <= STALE_MAX_MS
    ) {
      cache.delete(previousKey);
      cache.set(previousKey, previous);
      // Retain one background consumer after this HTTP response closes. A stale
      // tile is useful immediately; waiting for the token queue defeats SWR.
      const cooling = client?.cooldownState('grid');
      if (!cooling) {
        const { promise } = refresh(params, true);
        void promise.catch(() => {});
      }
      return {
        value: previous.value,
        stale: true,
        ...cooling,
      };
    }
    try {
      const { promise, group } = refresh(params);
      return { value: await joinFlight(promise, group, signal), stale: false };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (age(previous) <= STALE_MAX_MS)
        return {
          value: previous.value,
          stale: true,
          retryAfterS: error.retryAfterS,
          upstreamStatus: error.upstreamStatus,
        };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (
      status,
      value,
      { stale = false, retryAfterS, upstreamStatus } = {},
    ) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(Number.isFinite(retryAfterS)
          ? { 'Retry-After': String(retryAfterS) }
          : {}),
        ...(upstreamStatus
          ? { 'X-Upstream-Status': String(upstreamStatus) }
          : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = String(req.url || '/');
    const queryAt = url.indexOf('?');
    const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
    if (pathname !== '/observations' && pathname !== '/grid')
      return json(404, { error: 'unknown_route' });
    const params = requestParams(
      pathname,
      new URLSearchParams(queryAt < 0 ? '' : url.slice(queryAt + 1)),
      now(),
    );
    if (params.error) return json(400, { error: params.error });
    const controller = new AbortController();
    const abort = () => controller.abort();
    // IncomingMessage.close also fires after a complete request body. The
    // response close identifies the abandoned browser fetch, while aborted
    // covers a request cut short before it reached the response stage.
    req.once?.('aborted', abort);
    res.once?.('close', abort);
    try {
      const { value, stale, retryAfterS, upstreamStatus } = await acquire(
        params,
        controller.signal,
      );
      return json(200, stale ? { ...value, stale: true } : value, {
        stale,
        retryAfterS,
        upstreamStatus,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status =
        error.code === 'inaturalist_budget_exhausted'
          ? 503
          : error.status === 429
            ? 429
            : 502;
      const code =
        error.code === 'inaturalist_budget_exhausted'
          ? error.code
          : status === 429
            ? 'inaturalist_rate_limited'
            : 'inaturalist_unavailable';
      return json(
        status,
        { error: code },
        {
          retryAfterS: error.retryAfterS,
          upstreamStatus: error.upstreamStatus,
        },
      );
    } finally {
      req.removeListener?.('aborted', abort);
      res.removeListener?.('close', abort);
    }
  }

  return {
    name: 'inaturalist',
    configureServer({ middlewares }) {
      middlewares.use('/api/inaturalist', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/inaturalist', handler);
    },
  };
}
