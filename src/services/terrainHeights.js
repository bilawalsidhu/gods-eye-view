import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';

/** Construct an instance-owned terrainHeights service with explicit dependencies. */
export function createTerrainHeights({ source, signal, cacheMaxEntries }) {
  if (typeof source?.getHeights !== 'function')
    throw new TypeError('Terrain heights require a source');
  signal?.throwIfAborted();
  // src/data/terrainHeights.js — batched, cached client terrain-height resolver
  // (docs/plans/2026-07-05-entity-height-datum-fix.md Task 3).
  //
  // Resolves ELLIPSOIDAL ground height per (lat, lon) via the server-side
  // `/api/terrain/heights` proxy (Task 2 — Re:Earth `heights.json`, disk-cached,
  // serve-stale). When the proxy is unreachable (or errors) AND the point isn't
  // already warm in this module's in-memory cache, falls back to bundled-geoid
  // math (Task 1, `src/data/geoid.js`):
  //
  //   sourceOrthometricM (if finite) + geoidHeight(lat, lon)  → source:'geoid-fallback'
  //   else geoidHeight(lat, lon) alone (H≈0 "at the geoid/coast" prior) → source:'geoid-fallback'
  //
  // Two things learned building the Task 2 proxy (see its report, and the
  // ledger's T2 entry) that this module builds in:
  //
  //   1. The proxy's GET has a Node http header-size ceiling — empirically a
  //      single request much past ~700-1500 points (depending on coordinate
  //      precision) risks a raw socket-level 431 *before* the proxy's own
  //      request handler runs. So every network request this module issues is
  //      chunked at CHUNK_SIZE (64 points), well under that ceiling, and
  //      chunks are sent SEQUENTIALLY (not in parallel) to keep this client
  //      well-behaved against a single dev-server proxy.
  //   2. The proxy's disk cache is keyed by the raw `points` query string, with
  //      no eviction — so a client that varies coordinate precision or point
  //      order defeats the warm cache and grows the cache file unbounded. This
  //      module rounds every coordinate to 5 decimal places (~1.1 m of
  //      precision at the equator — comfortably tighter than any of this app's
  //      placement needs) BOTH for its own in-memory cache key AND for the
  //      points string sent to the proxy, so repeated calls (including calls
  //      from a fresh page load, a different camera batch, etc.) consistently
  //      hit the same warm proxy cache entry.

  /** Max points per outgoing request to `/api/terrain/heights` (see file header, point 1). */
  // Match the server's upstream batch so sequential upstream work also fits
  // within this client's 30-second request deadline when Re:Earth slows.
  const CHUNK_SIZE = 64;

  /** Avoid repeatedly hitting a known-failing proxy from warm fallback reads. */
  const GEOID_FALLBACK_COOLDOWN_MS = 60_000;

  /**
   * In-memory cache: `"lat.toFixed(5),lon.toFixed(5)"` -> `{ellipsoid, source}`.
   * Module-scoped (not exported) — the only reads are through
   * `cachedEllipsoidalGround` and the internal lookup in
   * `resolveEllipsoidalGround`.
   * @type {Map<string, {ellipsoid: number, source: 'reearth'|'geoid-fallback', retryAt?: number}>}
   */
  const cache = new Map();

  /**
   * Entry ceiling for the cache above.
   *
   * Without one it grows for as long as a session resolves new coordinates:
   * every 5dp point is its own key, and nothing ever removed one. Sized from
   * the server side of the same traffic — this project's
   * `.gev-cache/terrain-heights.json`, which receives exactly the points this
   * module asks for, held 6,189 entries after ordinary use. 50,000 is eight
   * times that working set (~5 MB at roughly 100 bytes per entry) and matches
   * the ceiling the proxy applies to its own copy. Overridable so the ceiling
   * can be exercised as behaviour rather than asserted as a constant.
   */
  const CACHE_MAX_ENTRIES = cacheMaxEntries ?? 50_000;

  /**
   * Trim to the ceiling, dropping the oldest insertions first.
   *
   * Insertion order, not true LRU: a Map iterates in insertion order, so this
   * is O(1) per eviction with nothing to maintain on the read path — and the
   * read path runs per frame. The cost of evicting a point that is still in
   * view is one re-resolve on the next warm, never a wrong height, because
   * terrain does not move.
   *
   * Called ONCE PER BATCH, after the response has been assembled — never from
   * the write itself. `resolveEllipsoidalGround` assembles its result by
   * reading each key back out of this cache, so evicting mid-batch would turn
   * points it had just resolved into `{ellipsoid: null, source:'unresolved'}`
   * whenever a single batch exceeded the ceiling. A batch is therefore always
   * answered in full, and the ceiling is restored immediately afterwards.
   */
  function pruneCache() {
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
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
    const entry = cache.get(cacheKey(lat, lon));
    return entry ? entry.ellipsoid : null;
  }

  /**
   * Field-test round 5 (2026-07-06, the "sea-level poison"): like
   * cachedEllipsoidalGround but returns null for geoid-FALLBACK entries —
   * only a real Re:Earth value counts. A fallback (cached when the proxy
   * failed mid-burst) is the geoid surface, which at Austin sits ~165 m below
   * the airport: floors built on it sank every sprite/trail, and the mesh
   * sampler's sanity gate rejected REAL surface samples against it. Floor
   * consumers read THIS; the plain read stays for display-only consumers.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cachedRealEllipsoidalGround(lat, lon) {
    const entry = cache.get(cacheKey(lat, lon));
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
  async function fetchChunk(chunk) {
    // lon,lat order (matches the proxy's documented `points=lon,lat;…` contract
    // and Task 2's implementation).
    const results = await source.getHeights(chunk, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const body = { results };
    if (!Array.isArray(body?.results))
      throw new Error('malformed terrain heights response (no results array)');
    if (body.results.length !== chunk.length) {
      throw new Error(
        `terrain heights response length mismatch (expected ${chunk.length}, got ${body.results.length})`,
      );
    }
    const out = new Map();
    // The proxy is documented to preserve input order (Task 2 report verifies
    // this against the live upstream), so map positionally rather than trust
    // the response's own lon/lat fields to re-match — those are also present
    // for callers who want them, but this module doesn't need them.
    for (let i = 0; i < chunk.length; i += 1) {
      const ellipsoid = body.results[i]?.ellipsoid;
      if (!Number.isFinite(ellipsoid))
        throw new Error(`non-finite ellipsoid height at index ${i}`);
      out.set(chunk[i].key, ellipsoid);
    }
    return out;
  }

  /**
   * Computes the geoid-fallback ellipsoidal height for one point per the
   * brief's fallback chain: `sourceOrthometricM + geoidHeight` when a finite
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
   *   every point in THAT chunk falls back to geoid math
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
  async function resolveEllipsoidalGround(coords) {
    signal?.throwIfAborted();
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
    // only ever hit the network once). Round 5: a geoid-FALLBACK entry does
    // NOT count as permanently warm — it was cached when the proxy failed
    // mid-burst and (at elevated terrain) is a sea-level poison that sank every
    // floor built on it. Give failed keys a short cooldown before re-requesting
    // so warm consumers do not hammer a failing proxy; after it expires, a
    // successful response replaces the fallback entry and clears the path.
    const uncached = [];
    const seenKeys = new Set();
    const now = Date.now();
    for (const item of work) {
      const entry = cache.get(item.key);
      const fallbackCooling =
        entry?.source === 'geoid-fallback' &&
        Number.isFinite(entry.retryAt) &&
        now < entry.retryAt;
      if (
        (entry && entry.source === 'reearth') ||
        fallbackCooling ||
        seenKeys.has(item.key)
      )
        continue;
      seenKeys.add(item.key);
      uncached.push(item);
    }

    // Resolve the network path in sequential <=CHUNK_SIZE chunks. Each chunk's
    // failure is isolated to that chunk's points (geoid fallback), so a single
    // bad chunk doesn't lose results for the rest of a large batch.
    for (let i = 0; i < uncached.length; i += CHUNK_SIZE) {
      const chunk = uncached.slice(i, i + CHUNK_SIZE);
      try {
        const resolved = await fetchChunk(chunk);
        signal?.throwIfAborted();
        for (const item of chunk) {
          const ellipsoid = resolved.get(item.key);
          // Round 6: only a FINITE value may be cached as 'reearth'. A point
          // the upstream response omitted used to cache {ellipsoid: undefined,
          // source: 'reearth'} — permanently "warm" yet empty, so its floor
          // read null forever and every later warm skipped it (ATL verify:
          // one contact frozen at the geoid while its neighbors resolved).
          // An omitted point now caches nothing and retries on the next warm.
          if (Number.isFinite(ellipsoid)) {
            cache.set(item.key, { ellipsoid, source: 'reearth' });
          }
        }
      } catch {
        signal?.throwIfAborted();
        // Proxy down (or cold cache had nothing to serve-stale) — fall back to
        // geoid math for every point in this chunk. `ensureGeoidReady()` is
        // awaited lazily, only on the fallback path, so the common (proxy
        // healthy) case never pays for the geoid grid's dynamic import.
        await ensureGeoidReady();
        signal?.throwIfAborted();
        for (const item of chunk) {
          const ellipsoid = geoidFallback(
            item.lat,
            item.lon,
            item.sourceOrthometricM,
          );
          cache.set(item.key, {
            ellipsoid,
            source: 'geoid-fallback',
            retryAt: Date.now() + GEOID_FALLBACK_COOLDOWN_MS,
          });
        }
      }
    }

    // Assemble the output in the original input order from the cache. A point
    // the upstream omitted has NO entry (round 6 — deliberately uncached so it
    // retries later): report it unresolved instead of throwing.
    const answer = work.map((item) => {
      const entry = cache.get(item.key);
      return entry
        ? { ellipsoid: entry.ellipsoid, source: entry.source }
        : { ellipsoid: null, source: 'unresolved' };
    });
    // Only now is it safe to trim: every value this batch owes has been read
    // back out of the cache and materialized above.
    pruneCache();
    return answer;
  }

  signal?.addEventListener('abort', () => cache.clear(), { once: true });
  return {
    cachedEllipsoidalGround,
    cachedRealEllipsoidalGround,
    resolveEllipsoidalGround,
  };
}
