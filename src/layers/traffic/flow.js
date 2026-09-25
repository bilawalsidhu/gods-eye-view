import * as Cesium from 'cesium';
import { prepareRoadSurfaces, trafficSurfaceReady } from './surface.js';
import { matchFlowToRoads } from '../../data/flowMatch.js';
import { MAX_DOTS } from './policy.js';

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

  async function applyFlowToRoads(roads, clamped, generation) {
    // Claim the work synchronously, before the first await, so `stats.loading`
    // covers this request from the same tick the caller started it — the
    // loading batch must not be able to close underneath an in-flight fetch.
    layerState._flowPending += 1;
    layerState._flowRoads = roads;
    // Geometry survives in the session cache; congestion does not. Never paint
    // an old match as current while a refresh is pending or has failed.
    for (const road of roads) if (!road.directFlow) road.flow = null;
    try {
      if (!layerState._flowStatusPromise) return; // status check not started — sim mode
      await layerState._flowStatusPromise;
      if (!layerState._liveMode || !layerState._enabled) return;
      if (generation !== layerState._loadGeneration) return;
      if (!Array.isArray(roads) || roads.length === 0) return;
      try {
        // Cached paths reach here without a live controller; the fetch paths
        // reuse theirs so one cancel covers both roads and flow.
        if (!layerState._activeFetchAbort)
          layerState._activeFetchAbort = new AbortController();
        const segments = await warmFlow(clamped, generation);
        if (generation !== layerState._loadGeneration || !layerState._enabled)
          return;
        const matchable = roads.filter(
          (road) => !road.directFlow && !road.simulatedOnly,
        );
        const { matches } = matchFlowToRoads(matchable, segments);
        for (let i = 0; i < matchable.length; i++)
          matchable[i].flow = matches[i];
        if (layerState._flowRoads === roads) layerState._flowError = null;
      } catch (e) {
        if (e?.name === 'AbortError') return;
        // Same guard the success path gets: a superseded request rejecting late
        // (or after disable() cleared the state) must not restore a stale
        // outage over newer good data.
        if (generation !== layerState._loadGeneration || !layerState._enabled)
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
  ) {
    const signal = layerState._activeFetchAbort?.signal;
    const current = () =>
      generation === layerState._loadGeneration && !signal?.aborted;
    if (!current()) return false;
    if (!roads.length) {
      // A streamed tile with no roads changes nothing on screen. A completed
      // pass with none (TomTom roads only, where TomTom has no flow) is valid
      // empty coverage: clear the old view and do not retry.
      if (label === 'Loaded tile') return false;
      parts.rendering.renderRoadsForAltitude([], altitude, label, trace);
      return true;
    }
    const scene = layerState._viewer.scene;
    const selected = parts.rendering
      .visibleRoadsForAltitude(roads, altitude)
      .filter((road) => {
        const camera = layerState._viewer.camera?.positionWC;
        const radius = Math.max(1200, altitude * 2);
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
      MAX_DOTS,
    );
    const admitted = selected.filter((r, i) => budgets[i] > 0);
    const camera = layerState._viewer.camera?.positionWC;
    if (camera)
      admitted.sort(
        (a, b) =>
          Cesium.Cartesian3.distanceSquared(camera, a.waypoints[0]) -
          Cesium.Cartesian3.distanceSquared(camera, b.waypoints[0]),
      );
    const ready = [];
    let lastPaint = 0;
    const paint = () => {
      if (!current() || !ready.length) return;
      parts.rendering.renderRoadsForAltitude(
        ready.slice(),
        altitude,
        label,
        trace,
      );
      lastPaint = performance.now();
    };
    const flowJob = applyFlowToRoads(roads, clamped, generation);
    flowJob
      .then(() => {
        if (current()) parts.model.recolorDotsInPlace(label);
      })
      .catch(() => {});
    const options = {
      onReady: (road) => {
        ready.push(road);
        if (!lastPaint || performance.now() - lastPaint >= 120) paint();
      },
    };
    let prepared = await prepareRoadSurfaces(
      admitted,
      layerState._viewer.scene,
      services.ground,
      [layerState._pointCollection],
      signal,
      options,
    );
    paint();
    // Missing mesh is a surface state, never an OpenFreeMap provider failure.
    // Retry locally for a bounded interval while usable roads remain visible.
    const deadline = performance.now() + 1500;
    while (
      !ready.length &&
      prepared.pending.length &&
      current() &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    if (current()) layerState._surfacePending = prepared.pending.length;
    if (
      current() &&
      !label.includes('tile') &&
      !label.includes('refined') &&
      scene.postRender &&
      (!trafficSurfaceReady(scene) || prepared.pending.length)
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
        )
          .catch(() => {})
          .finally(() => {
            if (current()) layerState._surfaceRefining = false;
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
