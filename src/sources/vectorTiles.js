import { phaseTiming } from './phaseTiming.js';
import { tilesForBounds } from '../data/tomtomTiles.js';
import { readResponseBytesCapped, readResponseJsonCapped } from './httpBody.js';

/** Validate a non-dateline geographic viewport before selecting a bounded grid. */
export function validTileBounds(box) {
  return (
    box &&
    [box.south, box.west, box.north, box.east].every(Number.isFinite) &&
    box.south >= -90 &&
    box.north <= 90 &&
    box.west >= -180 &&
    box.east <= 180 &&
    box.north > box.south &&
    box.east > box.west
  );
}

/** A decoded XYZ cache with bounded workers, reads, retained bytes and request lifetimes. */
export function createVectorTileSource({
  tileJsonUrl,
  template,
  allowedOrigin,
  decode,
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxTiles = 16,
  concurrency = 4,
  ttlMs = Infinity,
  maxEntries = 64,
  maxCacheBytes = 24 * 1024 * 1024,
  maxResponseBytes = 4 * 1024 * 1024,
  metadataCooldownMs = 5000,
  now = Date.now,
}) {
  const cache = new Map();
  const active = new Set();
  const flights = new Map();
  let cacheBytes = 0;
  let metadata = null;
  let metadataError = null;
  let metadataFlight = null;
  let metadataRetryAt = 0;
  let generation = 0;
  let fetched = 0;
  let activeWorkers = 0;
  const waiters = [];

  async function request(url, parentSignal, read) {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.throwIfAborted();
    parentSignal?.addEventListener('abort', abort, { once: true });
    active.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Vector tile request timed out', 'TimeoutError'),
        ),
      12_000,
    );
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        const status = Number.isFinite(response.status)
          ? response.status
          : null;
        throw Object.assign(
          new Error(
            status === null
              ? 'Vector tiles unavailable'
              : `Vector tiles unavailable (HTTP ${status})`,
          ),
          { status },
        );
      }
      const value = await read(response, controller.signal);
      controller.signal.throwIfAborted();
      return value;
    } catch (error) {
      // Retain request ownership until every failed read has been cancelled.
      controller.abort(error);
      await response?.body?.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
      active.delete(controller);
    }
  }

  async function getMetadata(signal) {
    signal?.throwIfAborted();
    if (metadata) return metadata;
    if (metadataError && (!metadataError.retryable || now() < metadataRetryAt))
      throw metadataError;
    metadataError = null;
    if (!metadataFlight) {
      const flight = {
        controller: new AbortController(),
        users: 0,
        promise: null,
      };
      const metadataStart = performance.now();
      metadataFlight = flight;
      flight.promise = (
        template
          ? Promise.resolve({ tiles: [template] })
          : request(
              tileJsonUrl,
              flight.controller.signal,
              (res, requestSignal) =>
                readResponseJsonCapped(res, 256 * 1024, requestSignal),
            )
      )
        .then((value) => {
          flight.controller.signal.throwIfAborted();
          const url = value?.tiles?.[0];
          if (
            typeof url !== 'string' ||
            !['{z}', '{x}', '{y}'].every((token) => url.includes(token))
          )
            throw Object.assign(new Error('Invalid vector tile metadata'), {
              retryable: false,
            });
          let parsed;
          try {
            parsed = new URL(
              url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'),
              allowedOrigin,
            );
          } catch {
            throw Object.assign(new Error('Invalid vector tile origin'), {
              retryable: false,
            });
          }
          if (
            parsed.origin !== allowedOrigin ||
            parsed.username ||
            parsed.password
          )
            throw Object.assign(new Error('Invalid vector tile origin'), {
              retryable: false,
            });
          if (!template)
            phaseTiming('tilejson-fetch', metadataStart, {
              source: allowedOrigin,
            });
          metadata = { ...value, template: url };
          return metadata;
        })
        .catch((error) => {
          if (flight.controller.signal.aborted || error.name === 'AbortError')
            throw error;
          metadataError = Object.assign(
            new Error('Vector tile metadata unavailable', { cause: error }),
            {
              status: error.status ?? null,
              name: error.name === 'TimeoutError' ? 'TimeoutError' : 'Error',
              retryable:
                error.retryable !== false && !(error instanceof SyntaxError),
            },
          );
          metadataRetryAt =
            now() + Math.min(30_000, Math.max(0, metadataCooldownMs));
          throw metadataError;
        })
        .finally(() => {
          if (metadataFlight === flight) metadataFlight = null;
        });
    }
    const flight = metadataFlight;
    flight.users += 1;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', abort);
      flight.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    }).finally(() => {
      // Each caller owns its wait; only the last departing caller cancels shared metadata.
      flight.users -= 1;
      if (!flight.users && metadataFlight === flight) {
        flight.controller.abort();
        metadataFlight = null;
      }
    });
  }

  async function acquire(signal) {
    signal?.throwIfAborted();
    if (activeWorkers >= concurrency) {
      await new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
        };
        const abort = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        waiters.push(waiter);
      });
    } else activeWorkers += 1;
  }

  function release() {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve();
    else activeWorkers -= 1;
  }

  function subscribe(flight, signal, key) {
    signal?.throwIfAborted();
    flight.users++;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      flight.promise
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener('abort', abort));
    }).finally(() => {
      if (--flight.users === 0 && flights.get(key) === flight) {
        flights.delete(key);
        flight.controller.abort();
      }
    });
  }

  async function getTile(tile, meta, signal, epoch) {
    signal?.throwIfAborted();
    const key = `${meta.template}:${tile.z}/${tile.x}/${tile.y}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
    let flight = flights.get(key);
    if (!flight) {
      flight = { controller: new AbortController(), users: 0 };
      const ownedSignal = flight.controller.signal;
      flights.set(key, flight);
      flight.promise = (async () => {
        await acquire(ownedSignal);
        try {
          ownedSignal.throwIfAborted();
          if (epoch !== generation)
            throw new DOMException('Source cleared', 'AbortError');
          fetched++;
          const url = meta.template
            .replace('{z}', tile.z)
            .replace('{x}', tile.x)
            .replace('{y}', tile.y);
          const fetchStart = performance.now();
          const bytes = await request(url, ownedSignal, (res, requestSignal) =>
            readResponseBytesCapped(res, maxResponseBytes, requestSignal),
          );
          phaseTiming('tile-fetch', fetchStart, {
            source: allowedOrigin,
            key,
            bytes: bytes.byteLength,
          });
          const decodeStart = performance.now();
          const value = decode(bytes, tile.z, tile.x, tile.y);
          phaseTiming('decode', decodeStart, { source: allowedOrigin, key });
          ownedSignal.throwIfAborted();
          // Body-based decoded-storage estimate; never stringify geometry on the load path.
          const size = bytes.byteLength * 4;
          if (epoch === generation && size <= maxCacheBytes) {
            if (cache.has(key)) cacheBytes -= cache.get(key).size;
            cache.delete(key);
            cache.set(key, { at: now(), value, size });
            cacheBytes += size;
            while (cache.size > maxEntries || cacheBytes > maxCacheBytes) {
              const oldest = cache.keys().next().value;
              cacheBytes -= cache.get(oldest).size;
              cache.delete(oldest);
            }
          }
          return value;
        } finally {
          release();
        }
      })().finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      });
    }
    return subscribe(flight, signal, key);
  }

  return {
    getMetadata,
    async fetchBounds(box, { zoom, signal, onTile } = {}) {
      if (
        !validTileBounds(box) ||
        !Number.isInteger(zoom) ||
        zoom < 0 ||
        zoom > 14
      )
        throw new TypeError('Invalid tile viewport');
      signal?.throwIfAborted();
      const epoch = generation;
      const metaStart = performance.now();
      const meta = await getMetadata(signal);
      phaseTiming('tilejson', metaStart, { source: allowedOrigin });
      const candidates = tilesForBounds(box, zoom, { maxTiles: maxTiles + 1 });
      const cx = candidates.reduce((n, t) => n + t.x, 0) / candidates.length;
      const cy = candidates.reduce((n, t) => n + t.y, 0) / candidates.length;
      candidates.sort(
        (a, b) =>
          Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
      );
      const limited = candidates.length > maxTiles;
      // Refuse over-wide views instead of silently sampling a northwest strip.
      if (limited)
        throw Object.assign(new Error('Zoom in for vector tile coverage'), {
          retryable: false,
          code: 'TILE_VIEW_TOO_WIDE',
        });
      let index = 0;
      const results = new Array(candidates.length);
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, candidates.length) },
          async () => {
            while (index < candidates.length) {
              const i = index++;
              try {
                results[i] = {
                  value: await getTile(candidates[i], meta, signal, epoch),
                };
                signal?.throwIfAborted();
                onTile?.(results[i].value, candidates[i]);
              } catch (error) {
                results[i] = { error };
              }
            }
          },
        ),
      );
      signal?.throwIfAborted();
      if (epoch !== generation)
        throw new DOMException('Source cleared', 'AbortError');
      const good = results.filter((result) => !result.error);
      if (!good.length && results.length) throw results[0].error;
      return {
        tiles: good.map((result) => result.value),
        partial: good.length !== results.length,
        limited,
      };
    },
    getStats: () => ({
      tilesFetched: fetched,
      cacheEntries: cache.size,
      cacheBytes,
    }),
    clear() {
      generation += 1;
      metadataFlight?.controller.abort();
      metadataFlight = null;
      metadata = null;
      metadataError = null;
      metadataRetryAt = 0;
      for (const flight of flights.values()) flight.controller.abort();
      flights.clear();
      for (const controller of active) controller.abort();
      cache.clear();
      cacheBytes = 0;
    },
  };
}
