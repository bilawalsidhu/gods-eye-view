import { RoadRequestError, roadRequestError } from './source.js';
import {
  isUnavailableCapability,
  sourceResponseError,
} from '../../sources/capability.js';
import {
  TRAFFIC_TIMING_ENABLED,
  TILE_CACHE_MAX_ENTRIES,
  FAST_FETCH_ALTITUDE,
} from './policy.js';

/** Retain complete parsed snapshots under both an LRU entry cap and a byte budget. */
export function cacheRoadSnapshot(
  entries,
  key,
  entry,
  { retain = true, maxBytes = 24 * 1024 * 1024 } = {},
) {
  entries.delete(key);
  if (!retain) return;
  entry.cacheBytes = new TextEncoder().encode(
    JSON.stringify([entry.major, entry.full]),
  ).byteLength;
  if (entry.cacheBytes > maxBytes) return;
  entries.set(key, entry);
  let bytes = 0;
  for (const value of entries.values()) bytes += value.cacheBytes || 0;
  while (entries.size > TILE_CACHE_MAX_ENTRIES || bytes > maxBytes) {
    const oldest = entries.keys().next().value;
    bytes -= entries.get(oldest).cacheBytes || 0;
    entries.delete(oldest);
  }
}

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Fetch road geometries from the selected vector tile source.
   *
   * Supports AbortController signals so in-flight requests can be cancelled
   * when the camera moves before the response arrives.
   *
   * @param {number} south - Southern latitude bound (degrees).
   * @param {number} west  - Western longitude bound (degrees).
   * @param {number} north - Northern latitude bound (degrees).
   * @param {number} east  - Eastern longitude bound (degrees).
   * @param {Object}  [opts]
   * @param {boolean} [opts.majorOnly=false]  - Restrict to major highway classes.
   * @param {number}  [opts.timeoutSec=25]    - Compatibility deadline for injected sources.
   * @param {AbortSignal} [opts.signal]       - Abort signal for cancellation.
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   * @returns {Promise<Object>} Parsed JSON response from vector tiles.
   * @throws {Error} If the HTTP response status is not OK.
   */

  async function fetchRoads(
    south,
    west,
    north,
    east,
    { majorOnly = false, timeoutSec = 25, signal } = {},
    trace = null,
  ) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingPass(
            trace,
            majorOnly ? 'major' : 'full',
            'proxy',
          )
        : null;
    if (state) trace.currentPass = state.pass;
    const fetchStart = state
      ? parts.timing.trafficTimingMark(state, 'fetch-start')
      : null;
    if (state) {
      parts.timing.trafficTimingMeasure(
        'last-camera-change-to-fetch-start',
        state,
        trace.cameraChangeMark,
        fetchStart,
      );
    }
    const response = await source.requestRoads(
      { south, west, north, east },
      { majorOnly, timeoutSec, signal },
    );

    if (!response.ok) {
      throw Object.assign(
        roadRequestError(response.status),
        sourceResponseError(
          (await response.json?.().catch(() => ({}))) ?? {},
          response,
          roadRequestError(response.status).message,
        ),
      );
    }

    if (!state) {
      const data = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(data?.roads))
        throw new Error('Malformed road snapshot');
      layerState._roadSource = data.roadSource || 'OpenStreetMap';
      layerState._roadPartial = Boolean(data.partial);
      return data;
    }

    if (state) {
      state.proxyCache = response.headers.get('x-overpass-cache');
      state.proxyUpstream = response.headers.get('x-overpass-upstream');
    }
    const responseStart = state
      ? parts.timing.trafficTimingMark(state, 'response-json-start', {
          responseStatus: response.status,
        })
      : null;
    if (state) {
      parts.timing.trafficTimingMeasure(
        'fetch-to-response',
        state,
        fetchStart,
        responseStart,
        {
          responseStatus: response.status,
        },
      );
    }
    const data = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(data?.roads)) throw new Error('Malformed road snapshot');
    if (state) {
      const responseEnd = parts.timing.trafficTimingMark(
        state,
        'response-json-end',
        {
          responseStatus: response.status,
        },
      );
      parts.timing.trafficTimingMeasure(
        'response-json',
        state,
        responseStart,
        responseEnd,
        {
          responseStatus: response.status,
        },
      );
    }
    layerState._roadSource = data.roadSource || 'OpenStreetMap';
    layerState._roadPartial = Boolean(data.partial);
    return data;
  }

  /** Abort any in-flight road fetch and clear the controller reference. */

  function cancelActiveFetch() {
    if (layerState._activeFetchAbort) {
      layerState._activeFetchAbort.abort();
      layerState._activeFetchAbort = null;
    }
  }

  /**
   * Load road data for the given viewport bounds and render traffic dots.
   *
   * Implements a two-pass fetch strategy with tile caching:
   *
   *  1. Check the tile cache (keyed by clamped bounding-box coordinates).
   *     - If a full road set is cached, render immediately and return.
   *     - If only major roads are cached, render those first.
   *  2. Fetch major roads from vector tiles (fast, small payload). Render.
   *  3. If altitude is low enough (< FAST_FETCH_ALTITUDE), fetch the full
   *     road graph (includes tertiary/residential). Render again to upgrade.
   *
   * Each fetch is guarded by a monotonic `_loadGeneration` counter so that
   * stale responses from superseded requests are silently discarded.
   *
   * @param {{south:number, west:number, north:number, east:number}} bounds
   *   Viewport bounds (will be clamped internally).
   * @param {number} altitude - Camera altitude in meters.
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   * @returns {Promise<void>}
   */

  async function loadRoadsForBounds(bounds, altitude, trace = null) {
    // Increment generation to invalidate any in-flight responses from prior calls
    const generation = ++layerState._loadGeneration;
    cancelActiveFetch();
    clearTimeout(layerState._retryTimer);
    layerState._retryTimer = null;
    layerState._flowPending = 0;
    layerState._activeFetchAbort = new AbortController();
    const requestSignal = layerState._activeFetchAbort.signal;
    const clamped = parts.viewport.clampBounds(bounds);

    // Cache key: fixed-precision bounding-box string for deterministic lookups
    const cacheKey = `${clamped.south.toFixed(4)},${clamped.west.toFixed(4)},${clamped.north.toFixed(4)},${clamped.east.toFixed(4)}`;

    if (cacheKey !== layerState._retryBoundsKey) {
      layerState._retryBoundsKey = cacheKey;
      layerState._retryDelayMs = 1500;
      layerState._retryAttempts = 0;
      layerState._roadRetryStopped = false;
    }
    layerState._roadError = null;

    layerState._fetching = true;
    // Only COMMIT these on success. Committing up-front means a failed road
    // fetch (rate-limited / feed down) still trips the overlap gate in
    // onCameraChanged, so a stationary user never retries (H3/H5). Stage the
    // prospective values and roll back if nothing rendered.
    const prevBounds = layerState._lastBounds;
    const prevViewCenter = layerState._lastViewCenter;
    layerState._lastBounds = clamped;
    layerState._lastViewCenter = parts.viewport.getBoundsCenter(clamped);
    let renderedSomething = false;
    layerState._detailError = null;
    layerState._detailLimited = false;

    let retryable = true;
    try {
      await parts.flow.ensureFlowStatus(requestSignal);
      requestSignal.throwIfAborted();
      layerState._roadSource = 'OpenStreetMap';
      let cache = layerState._tileCache.get(cacheKey);
      if (cache) {
        layerState._tileCache.delete(cacheKey);
        layerState._tileCache.set(cacheKey, cache);
      }
      if (!cache) {
        // LRU eviction: drop the oldest entry when cache exceeds the cap
        if (layerState._tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
          const oldest = layerState._tileCache.keys().next().value;
          layerState._tileCache.delete(oldest);
        }
        cache = { major: null, full: null };
        layerState._tileCache.set(cacheKey, cache);
      }

      // Fast path: full road set already cached — render and return.
      // Flow is (re)applied even on cache hits: roads cache for the session,
      // but congestion data has a 120s shelf life. The race renders within
      // FLOW_RENDER_RACE_MS either way; late flow recolors in place.
      if (cache.full) {
        layerState._roadPartial = false;
        layerState._detailLimited = Boolean(cache.detailLimited);
        renderedSomething = await parts.flow.applyFlowThenRender(
          cache.full,
          clamped,
          generation,
          altitude,
          'Cache full',
          trace,
        );
        return;
      }

      // Intermediate path: render cached major roads while fetching the rest
      if (cache.major) {
        layerState._roadPartial = false;
        if (
          !(await parts.flow.applyFlowThenRender(
            cache.major,
            clamped,
            generation,
            altitude,
            'Cache major',
            trace,
          ))
        )
          return;
        renderedSomething = true;
      } else {
        // Fetch major roads first (smaller payload, faster response)
        console.log(`[Data:Traffic] Fast fetch major roads [${cacheKey}]`);
        const majorData = await fetchRoads(
          clamped.south,
          clamped.west,
          clamped.north,
          clamped.east,
          {
            majorOnly: true,
            timeoutSec: 12,
            signal: requestSignal,
          },
          trace,
        );
        // Discard stale response if a newer load was triggered while waiting
        if (generation !== layerState._loadGeneration) return;
        cache.major = layerState._parseRoads(majorData, trace);
        cacheRoadSnapshot(layerState._tileCache, cacheKey, cache, {
          retain: !layerState._roadPartial,
        });
        if (
          !(await parts.flow.applyFlowThenRender(
            cache.major,
            clamped,
            generation,
            altitude,
            'Loaded major',
            trace,
          ))
        )
          return;
        renderedSomething = true;
      }

      // At higher altitude, major roads provide sufficient motion density
      if (altitude > FAST_FETCH_ALTITUDE) return;

      // Detailed pass: fetch the full road graph (tertiary, residential, etc.)
      console.log(`[Data:Traffic] Full fetch local roads [${cacheKey}]`);
      const fullData = await fetchRoads(
        clamped.south,
        clamped.west,
        clamped.north,
        clamped.east,
        {
          majorOnly: false,
          timeoutSec: 20,
          signal: requestSignal,
        },
        trace,
      );
      if (generation !== layerState._loadGeneration) return;

      layerState._detailLimited = Boolean(fullData.detailLimited);
      cache.detailLimited = layerState._detailLimited;
      cache.full = layerState._parseRoads(fullData, trace);
      cacheRoadSnapshot(layerState._tileCache, cacheKey, cache, {
        retain: !layerState._roadPartial,
      });
      if (
        !(await parts.flow.applyFlowThenRender(
          cache.full,
          clamped,
          generation,
          altitude,
          'Loaded full',
          trace,
        ))
      )
        return;
      renderedSomething = true;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      retryable = !isUnavailableCapability(e);
      layerState._roadRetryStopped = !retryable;
      if (generation === layerState._loadGeneration && !renderedSomething)
        layerState._roadError =
          e instanceof RoadRequestError
            ? e.message
            : roadRequestError(null).message;
      if (generation === layerState._loadGeneration && renderedSomething) {
        layerState._detailError = `Detailed roads unavailable — ${e instanceof RoadRequestError ? e.message : roadRequestError(null).message}`;
        layerState._roadPartial = true;
      }
      console.warn('[Data:Traffic] Fetch error:', e);
    } finally {
      if (generation === layerState._loadGeneration) {
        layerState._fetching = false;
        // Roll back the bounds commit if this load rendered nothing (e.g. the
        // road fetch failed). Leaving them committed would make the overlap
        // gate skip the retry while the user sits still. Guarded on generation so
        // a superseding load's commit is not clobbered.
        if (!renderedSomething) {
          layerState._lastBounds = prevBounds;
          layerState._lastViewCenter = prevViewCenter;
          if (
            layerState._enabled &&
            retryable &&
            layerState._retryAttempts < 3
          ) {
            layerState._retryAttempts += 1;
            layerState._retryTimer = setTimeout(() => {
              layerState._retryTimer = null;
              parts.viewport.onCameraChanged();
            }, layerState._retryDelayMs);
            layerState._retryDelayMs = Math.min(
              layerState._retryDelayMs * 2,
              30000,
            );
          }
        } else {
          layerState._retryDelayMs = 1500;
        }
      }
      // Keep this generation's controller until superseded or disabled: flow
      // can still be running after its paint deadline. An older finally must
      // never clear the controller belonging to a newer destination.
    }
  }
  const methods = {
    /**
     * No-op — traffic updates are entirely camera-driven, not timer-driven.
     * @returns {Promise<void>}
     */
    async update() {
      // No-op — updates are camera-driven
    },
  };

  return { fetchRoads, cancelActiveFetch, loadRoadsForBounds, methods };
}
