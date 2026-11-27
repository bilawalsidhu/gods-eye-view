import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';

/** Default live-entry ceiling for the in-memory cache (see CACHE_MAX_ENTRIES). */
export const DEFAULT_MAX_CACHE_ENTRIES = 20_000;

/**
 * Construct an instance-owned terrainHeights service with explicit dependencies.
 * `maxCacheEntries` overrides the cache bound; it exists so the bound is
 * testable without minting twenty thousand coordinates, mirroring the injectable
 * `maxBytes` on the GBFS reader.
 */
export function createTerrainHeights({
  source,
  signal,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
}) {
  if (typeof source?.getHeights !== 'function')
    throw new TypeError('Terrain heights require a source');
  signal?.throwIfAborted();
  // Resolves ELLIPSOIDAL ground height per (lat, lon) via the server-side
  // `/api/terrain/heights` proxy (Re:Earth `heights.json`, disk-cached,
  // serve-stale). When the proxy is unreachable (or errors) AND the point isn't
  // already warm in this module's in-memory cache, falls back to bundled-geoid
  // math (`src/data/geoid.js`):
  //
  //   sourceOrthometricM (if finite) + geoidHeight(lat, lon)  → source:'geoid-fallback'
  //   else geoidHeight(lat, lon) alone (H≈0 "at the geoid/coast" prior) → source:'geoid-fallback'
  //
  // Two constraints of the proxy shape these requests:
  // 1. A long GET can exceed Node's header-size ceiling before the request handler runs.
  // Send chunks of CHUNK_SIZE (64 points) sequentially.
  // 2. The disk cache keys on the raw points query string and has no eviction. Round
  // coordinates to five decimal places (~1.1 m) for both the in-memory key and the query
  // so repeat requests share entries.

  /** Max points per outgoing request to `/api/terrain/heights` (see file header, point 1). */
  // Match the server's upstream batch so sequential upstream work also fits
  // within this client's 30-second request deadline when Re:Earth slows.
  const CHUNK_SIZE = 64;

  /** Avoid repeatedly hitting a known-failing proxy from warm fallback reads. */
  const GEOID_FALLBACK_COOLDOWN_MS = 60_000;

  /**
   * Live entry ceiling for the cache below. The rounding in point 2 of the file
   * header makes repeated visits to one place share a key; it does nothing to
   * bound the number of DISTINCT places a session visits, and this cache had no
   * eviction, so a long session kept every coordinate it ever resolved for the
   * lifetime of the page.
   *
   * This is a bound, not a budget. At the ~111 m floor grid a city-scale
   * session stays well under it, so eviction is the pathological case rather
   * than the normal one and a well-behaved session sees no extra network. Sized
   * above the sibling caches (adsb.lol points 80, track history 200, TomTom
   * tiles 256) because a miss here costs a proxy round trip, not just RAM.
   */
  const CACHE_MAX_ENTRIES =
    Number.isFinite(maxCacheEntries) && maxCacheEntries > 0
      ? Math.floor(maxCacheEntries)
      : DEFAULT_MAX_CACHE_ENTRIES;

  /**
   * In-memory cache: `"lat.toFixed(5),lon.toFixed(5)"` -> `{ellipsoid, source}`.
   * Module-scoped (not exported) — the only reads are through
   * `cachedEllipsoidalGround` and the internal lookup in
   * `resolveEllipsoidalGround`. Bounded at CACHE_MAX_ENTRIES; write through
   * `cacheStore` and read a consumer-facing hit through `cacheTouch` so the
   * eviction order stays least-recently-used.
   * @type {Map<string, {ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}>}
   */
  const cache = new Map();

  /**
   * Store an entry and drop the coldest ones once past the cap. `Map` iterates
   * in insertion order, so deleting the first key evicts the least recently
   * used provided every write and every consumer read re-inserts its key.
   *
   * Recency rather than plain insertion order because revisits here are
   * spatial: a session comes back to cells near where it already was, so the
   * cell it is parked on must not be evicted merely for having been resolved
   * early.
   * @param {string} key
   * @param {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}} entry
   */
  function cacheStore(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const coldest = cache.keys().next().value;
      if (coldest === undefined) break;
      cache.delete(coldest);
    }
  }

  /**
   * Read an entry and promote it to newest, so a coordinate a consumer keeps
   * asking about survives eviction. Returns undefined on a miss.
   * @param {string} key
   * @returns {{ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}|undefined}
   */
  function cacheTouch(key) {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  /**
   * Builds the rounded cache key shared between the in-memory cache and the
   * `points` string sent to the proxy (see file header, point 2).
   * @param {number} lat
   * @param {number} lon
   * @returns {string}
   */
  function cacheKey(lat, lon) {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
  }

  /**
   * Synchronous read of a previously resolved ellipsoidal ground height.
   * Returns null if this exact (rounded) coordinate hasn't been resolved yet
   * by either the proxy path or the geoid-fallback path.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry ? entry.ellipsoid : null;
  }

  /**
   * Like cachedEllipsoidalGround, but only a real Re:Earth value counts. A geoid fallback
   * can sit far below the ground, sinking floors and making the mesh gate reject real
   * samples. Display-only consumers can use the plain read.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedRealEllipsoidalGround(lat, lon) {
    const entry = cacheTouch(cacheKey(lat, lon));
    return entry && entry.source === 'reearth' ? entry.ellipsoid : null;
  }

  /**
   * Fetches one chunk (<=CHUNK_SIZE points) from the `/api/terrain/heights`
   * proxy. Returns a Map keyed by the same rounded cache key so callers can
   * look results up positionally-independent of upstream response ordering.
   * Throws on any failure (non-ok response, network error, malformed body) —
   * callers decide the fallback behavior per point.
   * @param {Array<{key: string, lat: number, lon: number}>} chunk
   * @returns {Promise<Map<string, number>>} key -> ellipsoid height (m)
   */
  async function fetchChunk(chunk, requestSignal = signal) {
    // The proxy expects points in lon,lat order.
    const results = await source.getHeights(chunk, {
      signal: requestSignal
        ? AbortSignal.any([requestSignal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    if (!Array.isArray(results))
      throw new Error('malformed terrain heights response (no results array)');
    if (results.length !== chunk.length) {
      throw new Error(
        `terrain heights response length mismatch (expected ${chunk.length}, got ${results.length})`,
      );
    }
    const out = new Map();
    // The proxy preserves input order, so map positionally.
    for (let i = 0; i < chunk.length; i += 1) {
      const ellipsoid = results[i]?.ellipsoid;
      if (!Number.isFinite(ellipsoid))
        throw new Error(`non-finite ellipsoid height at index ${i}`);
      out.set(chunk[i].key, ellipsoid);
    }
    return out;
  }

  /**
   * Computes the geoid-fallback ellipsoidal height by the fallback chain:
   * `sourceOrthometricM + geoidHeight` when a finite
   * orthometric source height is available, else `geoidHeight` alone (treats
   * the point as if it were at the geoid, i.e. H≈0 — a coast-level prior).
   * Assumes `ensureGeoidReady()` has already resolved.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [sourceOrthometricM]
   * @returns {number}
   */
  function geoidFallback(lat, lon, sourceOrthometricM) {
    const n = geoidHeight(lat, lon);
    return Number.isFinite(sourceOrthometricM) ? sourceOrthometricM + n : n;
  }

  /**
   * Resolves ellipsoidal ground height for a batch of coordinates, in order.
   *
   * - Results already warm in the in-memory cache are returned without any
   *   network call.
   * - Remaining (deduplicated) coordinates are sent to `/api/terrain/heights`
   *   in sequential chunks of <=64 points.
   * - If a chunk request fails (network error, non-ok HTTP, malformed body),
   *   every point in THAT chunk without a real height in the failure's
   *   `partial` falls back to geoid math
   *   (`sourceOrthometricM + geoidHeight` or `geoidHeight` alone) rather than
   *   failing the whole batch — a transient proxy outage in the middle of a
   *   large batch shouldn't blank out entities whose chunk happened to land
   *   earlier or later.
   * - Every resolved value (proxy or fallback) is written back into the
   *   in-memory cache before this function returns, so a later call — even
   *   with a real proxy round-trip pending — sees a warm hit.
   *
   * @param {Array<{lat:number, lon:number, sourceOrthometricM?:number}>} coords
   * @returns {Promise<Array<{ellipsoid:number, source:'reearth'|'geoid-fallback'}>>}
   *   Same length and order as `coords`.
   */
  async function resolveEllipsoidalGround(
    coords,
    { signal: consumerSignal } = {},
  ) {
    const requestSignal =
      signal && consumerSignal
        ? AbortSignal.any([signal, consumerSignal])
        : consumerSignal || signal;
    requestSignal?.throwIfAborted();
    if (!Array.isArray(coords) || coords.length === 0) return [];

    // Build the per-input work list (key + original index) up front so the
    // final assembly can map back positionally regardless of how many inputs
    // shared a cache key or a chunk.
    const work = coords.map((c, index) => ({
      index,
      lat: c.lat,
      lon: c.lon,
      sourceOrthometricM: c.sourceOrthometricM,
      key: cacheKey(c.lat, c.lon),
    }));

    // Points not yet warm in the cache, deduplicated by key (multiple inputs —
    // even within the same call — naming the same rounded coordinate should
    // only ever hit the network once). A geoid fallback gets a short cooldown before
    // retrying so consumers share the backoff. A successful response replaces it.
    const uncached = [];
    const seenKeys = new Set();
    const now = Date.now();
    // What this call resolved or found warm, so the assembly below can report a
    // point even if a later chunk's writes pushed it past CACHE_MAX_ENTRIES.
    // Without it a batch big enough to evict its own entries would lose points
    // it had resolved.
    const resolvedThisCall = new Map();
    for (const item of work) {
      const entry = cacheTouch(item.key);
      const fallbackCooling =
        entry?.source === 'geoid-fallback' &&
        Number.isFinite(entry.retryAt) &&
        now < entry.retryAt;
      if ((entry && entry.source === 'reearth') || fallbackCooling) {
        resolvedThisCall.set(item.key, entry);
        continue;
      }
      if (seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      uncached.push(item);
    }

    // Resolve the network path in sequential <=CHUNK_SIZE chunks. Each chunk's
    // failure is isolated to that chunk's points (geoid fallback), so a single
    // bad chunk doesn't lose results for the rest of a large batch.
    for (let i = 0; i < uncached.length; i += CHUNK_SIZE) {
      const chunk = uncached.slice(i, i + CHUNK_SIZE);
      try {
        const resolved = await fetchChunk(chunk, requestSignal);
        requestSignal?.throwIfAborted();
        for (const item of chunk) {
          const entry = {
            ellipsoid: resolved.get(item.key),
            source: 'reearth',
          };
          resolvedThisCall.set(item.key, entry);
          cacheStore(item.key, entry);
        }
      } catch (error) {
        requestSignal?.throwIfAborted();
        // Proxy down (or cold cache had nothing to serve-stale) — fall back to
        // geoid math for the points in this chunk. A failure that still
        // carries real heights (the proxy's `partial`, e.g. cached points
        // during an upstream 429 pause) keeps them; only the rest use the
        // geoid. `ensureGeoidReady()` is awaited lazily, only on the fallback
        // path, so the common (proxy healthy) case never pays for the geoid
        // grid's dynamic import.
        const partial =
          Array.isArray(error?.partial) && error.partial.length === chunk.length
            ? error.partial
            : [];
        const fallback = [];
        chunk.forEach((item, index) => {
          const ellipsoid = partial[index]?.ellipsoid;
          if (!Number.isFinite(ellipsoid)) {
            fallback.push(item);
            return;
          }
          const entry = { ellipsoid, source: 'reearth' };
          resolvedThisCall.set(item.key, entry);
          cacheStore(item.key, entry);
        });
        if (fallback.length === 0) continue;
        await ensureGeoidReady();
        requestSignal?.throwIfAborted();
        for (const item of fallback) {
          const ellipsoid = geoidFallback(
            item.lat,
            item.lon,
            item.sourceOrthometricM,
          );
          const entry = {
            ellipsoid,
            source: 'geoid-fallback',
            retryAt: Date.now() + GEOID_FALLBACK_COOLDOWN_MS,
          };
          resolvedThisCall.set(item.key, entry);
          cacheStore(item.key, entry);
        }
      }
    }

    // Every point is in `resolvedThisCall`: warm, fetched, partial or geoid
    // fallback. One non-finite height in a 200 response sends the whole chunk
    // (up to 64 points) to the geoid fallback.
    return work.map((item) => {
      const { ellipsoid, source } =
        cache.get(item.key) || resolvedThisCall.get(item.key);
      return { ellipsoid, source };
    });
  }

  signal?.addEventListener('abort', () => cache.clear(), { once: true });
  return {
    cachedEllipsoidalGround,
    cachedRealEllipsoidalGround,
    resolveEllipsoidalGround,
  };
}
