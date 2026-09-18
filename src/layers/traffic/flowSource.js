import { tilesForBounds } from '../../data/tomtomTiles.js';
import { providerStatusFromResponse } from '../../sources/live/contract.js';
import { decodeFlowTile } from './flowDecode.js';

/**
 * Turn a failed tile response into the Error `deriveTrafficFlowError` reads:
 * `status`, the proxy's `code` (`no_key` / `bad_key` / `budget` /
 * `rate_limited` / `upstream`) and its structured `provider` status, so the
 * layer can name the real reason instead of a bare HTTP code.
 */
async function tileError(key, res) {
  let body = null;
  try {
    if (typeof res.json === 'function') body = await res.json();
  } catch {
    /* non-JSON failure body */
  }
  const code = typeof body?.error === 'string' ? body.error : null;
  const error = new Error(
    `flow tile ${key}: HTTP ${res.status}${code ? ` ${code}` : ''}`,
  );
  error.status = Number(res.status) || 0;
  error.code = code;
  error.provider = providerStatusFromResponse(res, body);
  if (error.provider && typeof body?.provider?.error === 'string')
    error.provider.error = body.provider.error.trim() || null;
  return error;
}

/** Own one decoded flow cache and its session counters. */
export function createFlowTileSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const DECODE_CACHE_TTL_MS = 120_000;
  /** @const {number} Max decoded tiles kept in memory before oldest-entry eviction. */
  const DECODE_CACHE_MAX_ENTRIES = 64;

  /**
   * Decoded-tile cache keyed by "z/x/y".
   * @type {Map<string, {at:number, segments:Array, provider:object|null}>}
   */
  const _decodeCache = new Map();
  /** @type {number} Session count of tile requests issued to the proxy (decode-cache misses). */
  let _tilesFetched = 0;
  /**
   * Provider status of the most recent successful flow fetch, aggregated over
   * its covering tiles: `stale` if ANY tile came from the proxy's last-good
   * store, `live` when every tile was fresh, null for a legacy proxy that
   * sends no X-Provider-* headers.
   * @type {{status:string, fetchedAtMs:number|null, ageSec:number|null, error:string|null}|null}
   */
  let _lastProvider = null;

  /** Aggregate per-tile provider statuses: any stale tile makes the fetch stale. */
  function aggregateProvider(entries) {
    let status = null;
    let fetchedAtMs = null;
    let error = null;
    for (const provider of entries) {
      if (!provider) continue;
      if (provider.status === 'stale' || status == null) {
        status = provider.status;
        error = provider.error || error;
      }
      if (
        provider.fetchedAtMs != null &&
        (fetchedAtMs == null || provider.fetchedAtMs < fetchedAtMs)
      )
        fetchedAtMs = provider.fetchedAtMs;
    }
    if (!status) return null;
    return {
      status,
      fetchedAtMs,
      ageSec:
        fetchedAtMs == null
          ? null
          : Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000)),
      error: status === 'stale' ? error : null,
    };
  }

  /** Insert into the decode cache with oldest-entry eviction. */
  function cacheSet(key, entry) {
    if (
      !_decodeCache.has(key) &&
      _decodeCache.size >= DECODE_CACHE_MAX_ENTRIES
    ) {
      const oldest = _decodeCache.keys().next().value;
      _decodeCache.delete(oldest);
    }
    _decodeCache.set(key, entry);
  }

  /**
   * Fetch + decode all flow tiles covering the given bounds.
   *
   * Tiles are fetched from the local proxy in parallel; each decoded tile is
   * cached in memory for 120 s (keyed z/x/y), so repeat calls for the same
   * viewport are free. Partial tile failures return the segments that DID
   * decode (last-good philosophy); the promise rejects only when every tile
   * failed (e.g. keyless 503, aborted signal, proxy down).
   *
   * @param {{south:number, west:number, north:number, east:number}} bounds - Degrees.
   * @param {Object} [opts]
   * @param {AbortSignal} [opts.signal] - Abort signal (camera moved / layer disabled).
   * @param {number} [opts.zoom=12] - Flow tile zoom level.
   * @returns {Promise<Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean}>>}
   *   Flat array of flow segments across all covering tiles.
   */
  async function fetchFlowForBounds(bounds, { signal, zoom = 12 } = {}) {
    signal?.throwIfAborted();
    const tiles = tilesForBounds(bounds, zoom);
    if (tiles.length === 0) return [];
    const now = Date.now();

    const results = await Promise.allSettled(
      tiles.map(async ({ z, x, y }) => {
        const key = `${z}/${x}/${y}`;
        const cached = _decodeCache.get(key);
        if (cached && now - cached.at < DECODE_CACHE_TTL_MS) return cached;

        _tilesFetched += 1;
        const res = await fetchImpl(`/api/tomtom/flow/${z}/${x}/${y}.pbf`, {
          signal,
        });
        if (!res.ok) throw await tileError(key, res);
        const segments = decodeFlowTile(await res.arrayBuffer(), z, x, y);
        signal?.throwIfAborted();
        const entry = {
          at: Date.now(),
          segments,
          provider: providerStatusFromResponse(res),
        };
        cacheSet(key, entry);
        return entry;
      }),
    );

    signal?.throwIfAborted();
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    if (fulfilled.length === 0) {
      throw results[0].reason instanceof Error
        ? results[0].reason
        : new Error('flow fetch failed');
    }
    _lastProvider = aggregateProvider(fulfilled.map((r) => r.value.provider));
    return fulfilled.flatMap((r) => r.value.segments);
  }

  /**
   * Session diagnostics for `getStats()` surfaces.
   * @returns {{tilesFetched:number, provider:object|null}} Count of tile
   *   requests issued to the proxy this session (decode-cache hits excluded)
   *   and the provider status of the latest successful flow fetch.
   */
  function getFlowSessionStats() {
    return { tilesFetched: _tilesFetched, provider: _lastProvider };
  }

  /** Clear the decode cache (tests + layer teardown). Session stats persist. */
  function resetFlowTileCache() {
    _decodeCache.clear();
    _lastProvider = null;
  }

  return { fetchFlowForBounds, getFlowSessionStats, resetFlowTileCache };
}
