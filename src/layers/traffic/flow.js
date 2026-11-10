import { roadIdentity } from './retention.js';
import * as geo from '../../geo/index.js';
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
import { msg } from '../../i18n/index.js';
import { nextTask } from '../../sources/vectorTiles.js';

/**
 * Camera distance, in metres, to a [lon, lat] road coordinate standing on the
 * local ground estimate (a local tangent-plane approximation, metres apart at
 * the traffic layer's kilometre range). Null without a camera.
 */
function groundDistanceFrom(camera, groundHeight = 0) {
  const view = camera && geo.cartographic.fromCartesian(camera);
  if (!view) return null;
  const clearance = view.height - (groundHeight || 0) - DOT_HEIGHT_OFFSET;
  const lat = geo.math.toDegrees(view.latitude);
  const lon = geo.math.toDegrees(view.longitude);
  const east = 111320 * Math.cos(view.latitude);
  return ([roadLon, roadLat]) =>
    Math.hypot((roadLon - lon) * east, (roadLat - lat) * 111320, clearance);
}

export function createFlow({ state: layerState, services, parts, source }) {
  const scratchScreen = geo.cartesian2.create();
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
    const code = typeof error.code === 'string' ? error.code : null;
    // English in state; trafficFeedPresentation translates it for the panel.
    // A hosted deployment limits each account (code from the server); the
    // local proxy has one daily budget (`budget`) and answers `no_key`.
    if (code === 'USAGE_LIMIT_REACHED')
      return msg('Monthly traffic allowance used');
    if (code === 'RATE_LIMITED') return msg('Traffic rate limit reached');
    if (status === 503 && code && code !== 'no_key')
      return msg('Traffic service unavailable');
    if (status === 503) return msg('TomTom key unavailable');
    if (status === 429) return msg('TomTom daily budget reached');
    if (status === 502 || status === 504)
      return msg('TomTom upstream unreachable');
    if (Number.isFinite(status)) return `TomTom flow error (HTTP ${status})`;
    return msg('TomTom flow unavailable');
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
            registerDynamicCredit(layerState._engine, TOMTOM_CREDIT);
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
    layerState._warmFlow = ensureFlowStatus(signal).then(async () => {
      if (!layerState._liveMode || generation !== layerState._loadGeneration)
        return [];
      if (typeof source.fetchFlowDetail !== 'function')
        return fetchFlowForBounds(clamped, { signal });
      // The proxy serves cached tiles once the TomTom budget is spent or the
      // upstream fails; carry that mark so getStats() reads STALE, not LIVE.
      const detail = await source.fetchFlowDetail(clamped, { signal });
      if (generation === layerState._loadGeneration) {
        layerState._flowStale = detail.stale === true;
        layerState._flowOldestTileAt = detail.oldestTileAt ?? null;
      }
      return detail.segments;
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
    if (layerState._waitForScene) {
      await layerState._waitForScene;
      if (generation !== layerState._loadGeneration || signal?.aborted)
        return false;
    }
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
    if (roads.length && !majorPreview && !label.includes('refined'))
      layerState._surfaceInput = { roads, bounds: clamped };
    const preparedRoads =
      layerState._preparedRoads || (layerState._preparedRoads = new Map());
    const refining = label.includes('refined');
    if (!refining) {
      layerState._surfaceRefining = false;
      layerState._surfaceRefineRemove?.();
      layerState._surfaceRefineRemove = null;
      layerState._surfaceRefineDeadline = null;
    }
    if (!roads.length) {
      // A streamed tile with no roads changes nothing on screen. A completed
      // pass with none (TomTom roads only, where TomTom has no flow) is valid
      // empty coverage: clear the old view and do not retry.
      if (label === 'Loaded tile') return false;
      parts.rendering.renderRoadsForAltitude([], altitude, label, trace);
      return true;
    }
    // Separate whole-graph preparation from tile completion and publication.
    await nextTask();
    if (!current()) return false;
    const engine = layerState._engine;
    if (!engine) return false;
    const size = engine.host.size();
    // The enable-time estimate can predate the first local mesh (especially
    // after an intercontinental jump). Once previews have measured roads, use
    // that local evidence to select the detail view at its real elevation.
    const localHeights = [];
    for (const prepared of preparedRoads.values()) {
      const height =
        geo.cartographic.fromCartesian(prepared.waypoints[0]).height -
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
    if (engine.picker.pickPositionSupported && size.width) {
      const probe = geo.cartesian2.create(size.width / 2, size.height * 0.6);
      try {
        const hit = engine.picker.pickPosition(probe);
        const height = hit && geo.cartographic.fromCartesian(hit).height;
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
          geo.cartesian3.clone(prepared.waypoints[i], road.waypoints[i]);
      } else if (
        (!road.surfaceReady || refining) &&
        (localHeights.length || depthHeight !== undefined)
      ) {
        road.surfaceReady = false;
        // Opposite source directions may share waypoint arrays. Provisional
        // selection must not overwrite an already measured sibling.
        road.waypoints = road.waypoints.map((point) =>
          geo.cartesian3.clone(point),
        );
        for (let i = 0; i < road.coords.length; i++) {
          const [lon, lat] = road.coords[i];
          const floor = services.ground?.cachedGroundFloor?.(lat, lon);
          const height =
            Number.isFinite(floor) && Math.abs(floor) <= 9000
              ? Math.max(floor, layerState._viewHeightEstimate)
              : layerState._viewHeightEstimate;
          geo.cartesian3.fromDegrees(
            lon,
            lat,
            height + DOT_HEIGHT_OFFSET,
            undefined,
            road.waypoints[i],
          );
        }
      }
    }
    // Camera distances are measured to the road's coordinates standing on the
    // local ground estimate, never to its waypoints. Until this pass samples
    // them again, waypoints keep the heights of whichever surface sampled them
    // last: after a globe switch the outgoing globe's, often taken from its
    // coarse first tiles (about -2 200 m at Austin on keyless Cesium). Weighted
    // by those, a returning globe's population fell from 620 to 260.
    const viewCamera = engine.camera.livePosition;
    const groundDistance = groundDistanceFrom(
      viewCamera,
      layerState._viewHeightEstimate,
    );
    const selected = parts.rendering
      .visibleRoadsForAltitude(roads, altitude)
      .filter((road) => {
        const localHeight = Math.max(
          0,
          altitude - (layerState._viewHeightEstimate || 0),
        );
        const radius = clamped.coverage
          ? clamped.coverage.rangeKm * 1000 + 1500
          : Math.max(1200, localHeight * 2);
        if (
          groundDistance &&
          road.coords.every((coordinate) => groundDistance(coordinate) > radius)
        )
          return false;
        // Spend surface work on roads crossing the canvas, with a small pan margin.
        if (!size.width) return true;
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const point of road.waypoints) {
          const screen = engine.projector.worldToWindow(point, scratchScreen);
          if (!screen) continue;
          minX = Math.min(minX, screen.x);
          maxX = Math.max(maxX, screen.x);
          minY = Math.min(minY, screen.y);
          maxY = Math.max(maxY, screen.y);
        }
        road.coverageBand = maxY < size.height / 2 ? 1 : 0;
        if (clamped.coverage && groundDistance) {
          road.baseDensityWeight ??= road.densityWeight || 1;
          road.densityWeight =
            road.baseDensityWeight /
            Math.max(1, groundDistance(road.coords[0]) / 1500);
        }
        return (
          maxX >= -100 &&
          minX <= size.width + 100 &&
          maxY >= -100 &&
          minY <= size.height + 100
        );
      });
    const budgets = parts.model.allocateRoadDotBudgets(
      selected,
      altitude,
      roadDotBudget(altitude),
    );
    const admitted = selected.filter((r, i) => budgets[i] > 0);
    const camera = engine.camera.livePosition;
    if (camera)
      admitted.sort(
        (a, b) =>
          geo.cartesian3.distanceSquared(camera, a.waypoints[0]) -
          geo.cartesian3.distanceSquared(camera, b.waypoints[0]),
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
          geo.cartesian3.clone(prepared.waypoints[i], road.waypoints[i]);
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
        if (!current()) return;
        parts.model.recolorDotsInPlace(label);
        // Flow cleared for this refresh may land after the roads were
        // published; their budgets then follow it too, not only the colours.
        if (layerState._liveMode) parts.retention?.retarget?.();
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
    // The first bounded surface slice needs its own task, not the prefix's tail.
    await nextTask();
    if (!current()) return false;
    let prepared = await prepareRoadSurfaces(
      unresolved,
      engine,
      services.ground,
      layerState._display?.excluded() ?? [],
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
      engine.render.request('traffic-surface');
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!current()) return false;
      prepared = await prepareRoadSurfaces(
        prepared.pending,
        engine,
        services.ground,
        layerState._display?.excluded() ?? [],
        signal,
        options,
      );
      paint();
    }
    paint(true);
    // A completed-mesh pass with no new heights cannot improve this view.
    // Keep the roads in _surfaceInput for a later view or surface change,
    // without leaving offscreen or unavailable stations loading forever.
    const retryPending =
      prepared.pending.length > 0 &&
      (!refining || performance.now() < layerState._surfaceRefineDeadline) &&
      (!refining ||
        !trafficSurfaceReady(engine) ||
        prepared.metrics.resolvedSamples > 0);
    if (current())
      layerState._surfacePending = retryPending ? prepared.pending.length : 0;
    if (
      current() &&
      !preview &&
      ((!refining && !trafficSurfaceReady(engine)) ||
        retryPending ||
        (!refining && ready.some((road) => road.surfaceSettled === false)))
    ) {
      layerState._surfaceRefineRemove?.();
      // A ready frame can start another pass; it must not renew the budget.
      layerState._surfaceRefineDeadline ??= performance.now() + 10000;
      const stop = () => {
        remove();
        clearTimeout(timer);
        if (layerState._surfaceRefineRemove === stop)
          layerState._surfaceRefineRemove = null;
      };
      const remove = engine.frames.postRender.addEventListener(() => {
        if (!current()) {
          stop();
          return;
        }
        if (!trafficSurfaceReady(engine)) {
          engine.render.request('traffic-surface');
          return;
        }
        stop();
        // Revalidate only local samples taken at a coarser rendered LOD. This
        // background upgrade never holds road acquisition or first paint;
        // missing samples retry while heights make progress and stay cached.
        layerState._surfaceRefining = true;
        applyFlowThenRender(
          roads,
          clamped,
          generation,
          altitude,
          refining ? label : `${label} refined`,
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
      const timer = setTimeout(
        () => {
          stop();
          if (current()) layerState._surfacePending = 0;
        },
        Math.max(0, layerState._surfaceRefineDeadline - performance.now()),
      );
      layerState._surfaceRefineRemove = stop;
      engine.render.request('traffic-surface');
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
