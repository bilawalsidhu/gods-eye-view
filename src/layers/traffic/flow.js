import { roadIdentity } from './retention.js';
import * as Cesium from 'cesium';
import {
  prepareRoadSurfaces,
  roadHeightStations,
  trafficSurfaceReady,
} from './surface.js';
import { matchFlowToRoads } from '../../data/flowMatch.js';
import {
  DOT_HEIGHT_OFFSET,
  FAST_FETCH_ALTITUDE,
  roadDotBudget,
} from './policy.js';

export function createFlow({ state: layerState, services, parts, source }) {
  const { registerDynamicCredit, TOMTOM_CREDIT } = services.credits;
  const { fetchFlowForBounds } = source;

  // ─── Live Flow (TomTom) ────────────────────────────────────

  /**
   * Map a failed flow fetch onto one short, honest user-facing reason.
   *
   * `fetchFlowForBounds` only rejects when EVERY covering tile failed, so a
   * non-null result here always means "there is no live flow to show right
   * now" — the dots fall back to simulated white. Mirrors the
   * `deriveAisFeedError` honesty helper.
   *
   * @param {Error|{name?:string, message?:string}|null|undefined} error - Rejection from the flow fetch.
   * @returns {string|null} Short reason, or null for an aborted (superseded) fetch.
   */

  function deriveTrafficFlowError(error) {
    if (!error || error.name === 'AbortError') return null;
    const message = String(error.message || error);
    const status = Number.isFinite(error.status)
      ? error.status
      : Number(message.match(/HTTP (\d{3})/)?.[1]);
    if (status === 503) return 'TomTom key unavailable';
    if (status === 429) return 'TomTom daily budget reached';
    if (status === 502 || status === 504) return 'TomTom upstream unreachable';
    if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
    return 'TomTom flow unavailable';
  }

  /**
   * Check `/api/tomtom/status` once per session and cache the result.
   * Live mode iff the server holds a TomTom key; the TomTom attribution credit
   * registers the first time live mode activates. Keyless or unreachable →
   * simulation mode, exactly today's behavior.
   *
   * @returns {Promise<void>} Resolves when `_liveMode` is settled.
   */

  function ensureFlowStatus(signal) {
    if (layerState._flowStatusSignal?.aborted)
      layerState._flowStatusPromise = null;
    if (!layerState._flowStatusPromise) {
      layerState._flowStatusSignal = signal;
      layerState._flowStatusPromise = source
        .getStatus({ signal })
        .then((status) => {
          if (layerState._flowStatusSignal === signal)
            layerState._flowStatusSignal = null;
          layerState._liveMode = Boolean(status?.hasKey);
          layerState._flowStatusUnavailable = false;
          layerState._flowStatusKnown = true;
          if (layerState._liveMode) {
            console.log('[Data:Traffic] TomTom key present — live flow mode');
            registerDynamicCredit(layerState._viewer, TOMTOM_CREDIT);
          }
        })
        .catch((e) => {
          if (e?.name === 'AbortError') throw e;
          if (layerState._flowStatusSignal === signal)
            layerState._flowStatusSignal = null;
          // Simulating because we could not ask, which is NOT the same as
          // "server says no key" — getStats() distinguishes the two.
          layerState._liveMode = false;
          layerState._flowStatusUnavailable = true;
          layerState._flowStatusKnown = true;
          console.warn(
            '[Data:Traffic] TomTom status unreachable — simulated traffic:',
            e?.message || e,
          );
        });
    }
    return layerState._flowStatusPromise;
  }

  /**
   * Live mode only: fetch TomTom flow for the clamped bounds, match it onto the
   * parsed roads, and attach `road.flow` (`{level, closure}` or null).
   *
   * Reuses the load-generation guard: stale flow responses are discarded, and
   * the shared AbortController lets `cancelActiveFetch()` (next load / disable)
   * cancel an in-flight flow fetch. Any failure leaves roads unmatched — the
   * dots then render in today's simulated white, never a phantom color — and is
   * recorded in `_flowError` so `getStats()` degrades honestly instead of
   * reporting a stale "LIVE · N% cov" over simulated dots.
   *
   * @param {Array} roads - Parsed road objects (mutated: `road.flow`).
   * @param {{south:number,west:number,north:number,east:number}} clamped - Fetch bounds.
   * @param {number} generation - `_loadGeneration` at call time.
   * @returns {Promise<void>}
   */

  async function applyFlowToRoads(roads, clamped, generation, signal) {
    // Claim the work synchronously, before the first await, so `stats.loading`
    // covers this request from the same tick the caller started it — the
    // loading batch must not be able to close underneath an in-flight fetch.
    layerState._flowPending += 1;
    layerState._flowRoads = roads;
    // Geometry survives in the session cache; congestion does not. Never paint
    // an old match as current while a refresh is pending or has failed.
    for (const road of roads) {
      road.key ||= roadIdentity(road);
      if (!road.directFlow) road.flow = null;
    }
    try {
      if (!layerState._flowStatusPromise) return; // status check not started — sim mode
      await layerState._flowStatusPromise;
      if (!layerState._liveMode || !layerState._enabled) return;
      if (generation !== layerState._loadGeneration || signal?.aborted) return;
      if (!Array.isArray(roads) || roads.length === 0) return;
      try {
        // Cached paths reach here without a live controller; the fetch paths
        // reuse theirs so one cancel covers both roads and flow.
        if (!layerState._activeFetchAbort)
          layerState._activeFetchAbort = new AbortController();
        const segments = await warmFlow(clamped, generation);
        if (
          generation !== layerState._loadGeneration ||
          !layerState._enabled ||
          signal?.aborted
        )
          return;
        if (layerState._matchedFlowGeneration !== generation) {
          layerState._matchedFlowGeneration = generation;
          layerState._matchedFlow = new Map();
        }
        const memo = layerState._matchedFlow;
        const matchable = roads.filter(
          (road) =>
            !road.directFlow && !road.simulatedOnly && !memo.has(road.key),
        );
        const { matches } = matchFlowToRoads(matchable, segments);
        for (let i = 0; i < matchable.length; i++)
          memo.set(matchable[i].key, matches[i]);
        for (const road of roads)
          if (!road.directFlow && !road.simulatedOnly)
            road.flow = memo.get(road.key) || null;
        if (layerState._flowRoads === roads) layerState._flowError = null;
      } catch (e) {
        if (e?.name === 'AbortError') return;
        // Same guard the success path gets: a superseded request rejecting late
        // (or after disable() cleared the state) must not restore a stale
        // outage over newer good data.
        if (
          generation !== layerState._loadGeneration ||
          !layerState._enabled ||
          signal?.aborted
        )
          return;
        // Every covering tile failed: there is no live flow on screen. Drop the
        // now-false coverage number and surface the reason through getStats().
        if (layerState._flowRoads === roads)
          layerState._flowError = deriveTrafficFlowError(e);
        console.warn(
          '[Data:Traffic] Flow fetch failed (sim colors remain):',
          e?.message || e,
        );
      }
    } finally {
      if (generation === layerState._loadGeneration)
        layerState._flowPending -= 1;
    }
  }

  // One flow acquisition per generation, started alongside road acquisition.
  function warmFlow(clamped, generation) {
    if (layerState._warmFlowGeneration === generation)
      return layerState._warmFlow;
    layerState._warmFlowGeneration = generation;
    const signal = layerState._activeFetchAbort?.signal;
    layerState._warmFlow = ensureFlowStatus(signal).then(() => {
      if (!layerState._liveMode || generation !== layerState._loadGeneration)
        return [];
      return fetchFlowForBounds(clamped, { signal });
    });
    layerState._warmFlow.catch(() => {});
    return layerState._warmFlow;
  }

  /** Paint locally resolved roads incrementally; flow never delays surface work. */
  async function applyFlowThenRender(
    roads,
    clamped,
    generation,
    altitude,
    label,
    trace = null,
    majorPreview = false,
    signal = layerState._activeFetchAbort?.signal,
  ) {
    if (generation !== layerState._loadGeneration || signal?.aborted)
      return false;
    const revision = (layerState._surfaceRevision || 0) + 1;
    layerState._surfaceRevision = revision;
    const current = () =>
      generation === layerState._loadGeneration &&
      revision === layerState._surfaceRevision &&
      !signal?.aborted;
    if (!current()) return false;
    // Once traffic exists, retain it while the concurrently acquired detail
    // snapshot finishes. Repeated coarse/tile previews sample roads that are
    // immediately replaced, delaying the final population after every move.
    if (
      altitude <= FAST_FETCH_ALTITUDE &&
      layerState._roadSource !== 'TomTom' &&
      (layerState._dots.length ||
        (layerState._detailRoadsReady && layerState._motion?.added > 0)) &&
      (majorPreview || label === 'Loaded tile' || label === 'Loaded major')
    ) {
      layerState._retainedPreview = true;
      return true;
    }
    const preparedRoads =
      layerState._preparedRoads || (layerState._preparedRoads = new Map());
    const refining = label.includes('refined');
    if (!refining) {
      layerState._surfaceRefining = false;
      layerState._surfaceRefineRemove?.();
      layerState._surfaceRefineRemove = null;
    }
    if (!roads.length) {
      // A streamed tile with no roads changes nothing on screen. A completed
      // pass with none (TomTom roads only, where TomTom has no flow) is valid
      // empty coverage: clear the old view and do not retry.
      if (label === 'Loaded tile') return false;
      parts.rendering.renderRoadsForAltitude([], altitude, label, trace);
      return true;
    }
    const scene = layerState._viewer.scene;
    // The enable-time estimate can predate the first local mesh (especially
    // after an intercontinental jump). Once previews have measured roads, use
    // that local evidence to select the detail view at its real elevation.
    const localHeights = [];
    for (const prepared of preparedRoads.values()) {
      const height =
        Cesium.Cartographic.fromCartesian(prepared.waypoints[0]).height -
        DOT_HEIGHT_OFFSET;
      if (Number.isFinite(height) && Math.abs(height) <= 9000)
        localHeights.push(height);
      if (localHeights.length === 9) break;
    }
    if (localHeights.length) {
      localHeights.sort((a, b) => a - b);
      layerState._viewHeightEstimate =
        localHeights[Math.floor(localHeights.length / 2)];
    }
    // A rendered center-depth pick follows the current city's elevation even
    // while older coarse samples are being replaced. It is selection-only.
    let depthHeight;
    if (scene.pickPositionSupported && scene.canvas?.clientWidth) {
      const probe = new Cesium.Cartesian2(
        scene.canvas.clientWidth / 2,
        scene.canvas.clientHeight * 0.6,
      );
      try {
        const hit = scene.pickPosition(probe);
        const height = hit && Cesium.Cartographic.fromCartesian(hit).height;
        if (Number.isFinite(height) && Math.abs(height) <= 9000)
          depthHeight = height;
      } catch {
        /* no rendered depth yet */
      }
    }
    if (depthHeight !== undefined) layerState._viewHeightEstimate = depthHeight;
    for (const road of roads) {
      road.key ||= roadIdentity(road);
      const prepared = !refining && preparedRoads.get(road.key);
      if (prepared) {
        for (let i = 0; i < road.waypoints.length; i++)
          Cesium.Cartesian3.clone(prepared.waypoints[i], road.waypoints[i]);
      } else if (
        (!road.surfaceReady || refining) &&
        (localHeights.length || depthHeight !== undefined)
      ) {
        road.surfaceReady = false;
        // Opposite source directions may share waypoint arrays. Provisional
        // selection must not overwrite an already measured sibling.
        road.waypoints = road.waypoints.map((point) =>
          Cesium.Cartesian3.clone(point),
        );
        for (let i = 0; i < road.coords.length; i++) {
          const [lon, lat] = road.coords[i];
          const floor = services.ground?.cachedGroundFloor?.(lat, lon);
          const height =
            Number.isFinite(floor) && Math.abs(floor) <= 9000
              ? Math.max(floor, layerState._viewHeightEstimate)
              : layerState._viewHeightEstimate;
          Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            height + DOT_HEIGHT_OFFSET,
            undefined,
            road.waypoints[i],
          );
        }
      }
    }
    const selected = parts.rendering
      .visibleRoadsForAltitude(roads, altitude)
      .filter((road) => {
        const camera = layerState._viewer.camera?.positionWC;
        const localHeight = Math.max(
          0,
          altitude - (layerState._viewHeightEstimate || 0),
        );
        const radius = clamped.coverage
          ? clamped.coverage.rangeKm * 1000 + 1500
          : Math.max(1200, localHeight * 2);
        if (
          camera &&
          road.waypoints.every(
            (point) =>
              Cesium.Cartesian3.distanceSquared(camera, point) >
              radius * radius,
          )
        )
          return false;
        // Spend surface work on roads crossing the canvas, with a small pan margin.
        if (!scene.canvas?.clientWidth) return true;
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const point of road.waypoints) {
          const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
            scene,
            point,
          );
          if (!screen) continue;
          minX = Math.min(minX, screen.x);
          maxX = Math.max(maxX, screen.x);
          minY = Math.min(minY, screen.y);
          maxY = Math.max(maxY, screen.y);
        }
        road.coverageBand = maxY < scene.canvas.clientHeight / 2 ? 1 : 0;
        if (clamped.coverage && camera) {
          road.baseDensityWeight ??= road.densityWeight || 1;
          road.densityWeight =
            road.baseDensityWeight /
            Math.max(
              1,
              Cesium.Cartesian3.distance(camera, road.waypoints[0]) / 1500,
            );
        }
        return (
          maxX >= -100 &&
          minX <= scene.canvas.clientWidth + 100 &&
          maxY >= -100 &&
          minY <= scene.canvas.clientHeight + 100
        );
      });
    const budgets = parts.model.allocateRoadDotBudgets(
      selected,
      altitude,
      roadDotBudget(altitude),
    );
    const admitted = selected.filter((r, i) => budgets[i] > 0);
    const camera = layerState._viewer.camera?.positionWC;
    if (camera)
      admitted.sort(
        (a, b) =>
          Cesium.Cartesian3.distanceSquared(camera, a.waypoints[0]) -
          Cesium.Cartesian3.distanceSquared(camera, b.waypoints[0]),
      );
    // The wide pass is a fast preview when detailed tiles follow. Preparing
    // the entire coarse graph only to replace it doubles surface work.
    const preview =
      label.includes('tile') ||
      (altitude <= FAST_FETCH_ALTITUDE &&
        layerState._roadSource !== 'TomTom' &&
        (majorPreview || label.includes('major')));
    if (preview) admitted.length = Math.min(admitted.length, 32);
    // Mesh picks are synchronous GPU work. Bound the unique height stations
    // as well as the dot count: a one-dot long road can otherwise cost dozens
    // of picks. Nearest roads win, and the fixed coordinate budget gives cold
    // and warm views the same deterministic coverage.
    const stations = new Set();
    const bounded = [];
    const upper = clamped.coverage
      ? admitted.filter((r) => r.coverageBand === 1)
      : [];
    const lower = clamped.coverage
      ? admitted.filter((r) => r.coverageBand !== 1)
      : admitted;
    const ordered = [];
    for (let i = 0; i < Math.max(upper.length, lower.length); i++) {
      if (lower[i]) ordered.push(lower[i]);
      if (upper[i]) ordered.push(upper[i]);
    }
    for (const road of ordered) {
      const keys = roadHeightStations(road.coords).indices.map(
        (i) =>
          `${road.coords[i][0].toFixed(6)},${road.coords[i][1].toFixed(6)}`,
      );
      const fresh = [...new Set(keys)].filter((key) => !stations.has(key));
      if (stations.size + fresh.length > 1000) continue;
      for (const key of fresh) stations.add(key);
      bounded.push(road);
    }
    layerState._surfaceBudgetOmitted = admitted.length - bounded.length;
    admitted.length = 0;
    admitted.push(...bounded);
    const ready = [];
    const unresolved = [];
    for (const road of admitted) {
      road.key ||= roadIdentity(road);
      const prepared = !refining && preparedRoads.get(road.key);
      if (prepared) {
        for (let i = 0; i < road.waypoints.length; i++)
          Cesium.Cartesian3.clone(prepared.waypoints[i], road.waypoints[i]);
        for (let i = 0; i < road.segmentDist.length; i++)
          road.segmentDist[i] = prepared.segmentDist[i];
        road.surfaceReady = true;
        road.surfaceSettled = prepared.surfaceSettled;
        ready.push(road);
      } else unresolved.push(road);
    }
    let lastPaint = 0;
    let painted = 0;
    const paint = (complete = false) => {
      if (!current() || !ready.length) return;
      if (!complete && painted === ready.length) return;
      parts.rendering.renderRoadsForAltitude(
        complete ? ready : ready.slice(painted),
        altitude,
        label,
        trace,
        complete && !preview,
      );
      painted = ready.length;
      lastPaint = performance.now();
    };
    paint();
    const flowJob = applyFlowToRoads(admitted, clamped, generation, signal);
    flowJob
      .then(() => {
        if (current()) parts.model.recolorDotsInPlace(label);
      })
      .catch(() => {});
    const options = {
      // A tileset can briefly report loaded before finer destination tiles
      // start streaming. The one completed-mesh pass must replace those early
      // cache entries even when camera distance stayed in the same band.
      revalidate: refining,
      onReady: (road) => {
        if (!current()) return;
        ready.push(road);
        preparedRoads.set(road.key, road);
        if (!lastPaint || performance.now() - lastPaint >= 120) paint();
      },
    };
    let prepared = await prepareRoadSurfaces(
      unresolved,
      layerState._viewer.scene,
      services.ground,
      [layerState._pointCollection],
      signal,
      options,
    );
    paint();
    // Missing mesh is a surface state, never an OpenFreeMap provider failure.
    // Only completed snapshots retry locally. A provisional tile/major pass
    // must never hold the detail fetch behind unresolved preview stations.
    const deadline = performance.now() + 1500;
    while (
      !preview &&
      !ready.length &&
      prepared.pending.length &&
      current() &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!current()) return false;
      prepared = await prepareRoadSurfaces(
        prepared.pending,
        layerState._viewer.scene,
        services.ground,
        [layerState._pointCollection],
        signal,
        options,
      );
      paint();
    }
    paint(true);
    if (current()) layerState._surfacePending = prepared.pending.length;
    if (
      current() &&
      !preview &&
      !label.includes('refined') &&
      scene.postRender &&
      (!trafficSurfaceReady(scene) ||
        prepared.pending.length ||
        ready.some((road) => road.surfaceSettled === false))
    ) {
      layerState._surfaceRefineRemove?.();
      const stop = () => {
        remove();
        clearTimeout(timer);
        if (layerState._surfaceRefineRemove === stop)
          layerState._surfaceRefineRemove = null;
      };
      const remove = scene.postRender.addEventListener(() => {
        if (!current()) {
          stop();
          return;
        }
        if (!trafficSurfaceReady(scene)) return;
        stop();
        // Revalidate only local samples taken at a coarser rendered LOD. This
        // background upgrade never holds road acquisition or first paint.
        layerState._surfaceRefining = true;
        applyFlowThenRender(
          roads,
          clamped,
          generation,
          altitude,
          `${label} refined`,
          trace,
          false,
          signal,
        )
          .catch(() => {})
          .finally(() => {
            if (
              generation === layerState._loadGeneration &&
              layerState._surfaceRevision === revision + 1
            )
              layerState._surfaceRefining = false;
          });
      });
      const timer = setTimeout(stop, 10000);
      layerState._surfaceRefineRemove = stop;
    }
    return current() && ready.length > 0;
  }

  return {
    deriveTrafficFlowError,
    ensureFlowStatus,
    applyFlowToRoads,
    warmFlow,
    applyFlowThenRender,
  };
}
