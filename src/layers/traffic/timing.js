import * as Cesium from 'cesium';
import { roadSurfaceChunks } from './surface.js';
import { TRAFFIC_TIMING_ENABLED, DOT_HEIGHT_OFFSET } from './policy.js';

export function createTiming({ state: layerState, services, parts, source }) {
  /**
   * Return development timing counters for the capture harness and inertness test.
   * This named export is unused by the application and removed from production.
   * @returns {{enabled:boolean, marksInstalled:number, traceObjectsCreated:number,
   *   uncorrelatedTracesDropped:number}}
   */

  function getTrafficTimingDiagnostics() {
    return {
      enabled: Boolean(TRAFFIC_TIMING_ENABLED),
      marksInstalled: layerState._trafficTimingMoveEndRemover ? 1 : 0,
      traceObjectsCreated: layerState._trafficTimingTracesCreated,
      uncorrelatedTracesDropped: layerState._trafficTimingDroppedTraces,
    };
  }

  // ─── Development-only causal timing ───────────────────────

  /**
   * Return (and optionally update) the current trace's state for a render pass.
   * This function is only reachable when `TRAFFIC_TIMING_ENABLED` is true.
   *
   * @param {Object|null} trace - Correlated load trace.
   * @param {'major'|'full'} pass - Road-fetch/render pass.
   * @param {string} [source] - Client cache or proxy/network source.
   * @returns {Object|null} Mutable pass timing state.
   */

  function trafficTimingPass(trace, pass, source) {
    if (!trace) return null;
    let state = trace.passes.get(pass);
    if (!state) {
      state = {
        trace,
        pass,
        source: source || 'unknown',
        proxyCache: null,
        proxyUpstream: null,
      };
      trace.passes.set(pass, state);
    } else if (source) {
      state.source = source;
    }
    return state;
  }

  /** Build a structured-clone-safe detail object for User Timing entries. */

  function trafficTimingDetail(state, segment, extra = {}) {
    return {
      trafficTiming: true,
      segment,
      traceId: state?.trace?.id ?? null,
      interactionId: state?.trace?.interactionId ?? null,
      cameraChangeTimestamp: state?.trace?.cameraChangeTimestamp ?? null,
      generation: state?.trace?.generation ?? null,
      cacheKey: state?.trace?.cacheKey ?? null,
      pass: state?.pass || 'load',
      source: state?.source || 'unknown',
      proxyCache: state?.proxyCache || null,
      proxyUpstream: state?.proxyUpstream || null,
      ...extra,
    };
  }

  /** Add a uniquely named User Timing mark and return its name. */

  function trafficTimingMark(state, phase, extra = {}, startTime) {
    const traceId = state?.trace?.id ?? 'interaction';
    const pass = state?.pass || 'load';
    const name = `traffic:${traceId}:${pass}:${phase}:${++layerState._trafficTimingSequence}`;
    const options = { detail: trafficTimingDetail(state, phase, extra) };
    if (Number.isFinite(startTime)) options.startTime = startTime;
    performance.mark(name, options);
    return name;
  }

  /** Emit a named User Timing measure between two marks. */

  function trafficTimingMeasure(segment, state, start, end, extra = {}) {
    performance.measure(`traffic:${segment}:${state?.pass || 'load'}`, {
      start,
      end,
      detail: trafficTimingDetail(state, segment, extra),
    });
  }

  /** Emit an aggregate-duration measure without pretending its work was contiguous. */

  function trafficTimingAggregate(
    segment,
    state,
    anchorTime,
    duration,
    extra = {},
  ) {
    const start = trafficTimingMark(
      state,
      `${segment}-aggregate-start`,
      extra,
      anchorTime,
    );
    const end = trafficTimingMark(
      state,
      `${segment}-aggregate-end`,
      extra,
      anchorTime + duration,
    );
    trafficTimingMeasure(segment, state, start, end, {
      aggregate: true,
      ...extra,
    });
  }

  /** Clear only this module's stale User Timing entries before a new debug run. */

  function clearTrafficTimingEntries() {
    const markNames = new Set(
      performance
        .getEntriesByType('mark')
        .filter((entry) => entry.name.startsWith('traffic:'))
        .map((entry) => entry.name),
    );
    const measureNames = new Set(
      performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('traffic:'))
        .map((entry) => entry.name),
    );
    for (const name of markNames) performance.clearMarks(name);
    for (const name of measureNames) performance.clearMeasures(name);
  }

  /** Return the stable User Timing mark name for a scheduling interaction. */

  function trafficTimingCameraChangeMarkName(interactionId) {
    return `traffic:interaction:${interactionId}:last-camera-change`;
  }

  /** Mint and mark the exact camera-change interaction that armed a debounced load. */

  function markTrafficTimingCameraChange() {
    const interactionId = ++layerState._trafficTimingSequence;
    const timestamp = performance.now();
    const anchor = { interactionId, timestamp };
    layerState._trafficTimingCurrentAnchor = anchor;
    performance.mark(trafficTimingCameraChangeMarkName(interactionId), {
      startTime: timestamp,
      detail: {
        trafficTiming: true,
        segment: 'last-camera-change',
        interactionId,
        timestamp,
      },
    });
    return anchor;
  }

  /**
   * Mark Cesium's diagnostic moveEnd notification. Cesium normally emits this
   * about 500 ms after stillness, so fetch has typically already started and
   * never waits for this boundary.
   */

  function markTrafficTimingMoveEnd() {
    const diagnosticId = ++layerState._trafficTimingSequence;
    const timestamp = performance.now();
    const name = `traffic:diagnostic:${diagnosticId}:camera-move-end`;
    performance.mark(name, {
      startTime: timestamp,
      detail: {
        trafficTiming: true,
        segment: 'camera-move-end',
        diagnosticOnly: true,
        cameraEventWaitTimeMs: 500,
        fetchWaitsForMoveEnd: false,
        timestamp,
      },
    });
  }

  /**
   * Instrumented twin of `parseRoads`. Operation ordering and road output match
   * the normal function; debug-only clocks accumulate synchronous height and
   * waypoint-materialization time independently.
   */

  function parseRoadsTimed(roadData, trace) {
    /* TRACE_ONLY_BEGIN */
    const _trafficTimingState = trafficTimingPass(
      trace,
      trace?.currentPass || 'full',
    );
    const _trafficTimingParseStartTime = performance.now();
    const _trafficTimingParseStart = trafficTimingMark(
      _trafficTimingState,
      'road-parse-start',
      {},
      _trafficTimingParseStartTime,
    );
    /* TRACE_ONLY_END */
    if (!roadData || !roadData.roads) {
      /* TRACE_ONLY_BEGIN */
      const _trafficTimingParseEnd = trafficTimingMark(
        _trafficTimingState,
        'road-parse-end',
        { roadCount: 0 },
      );
      trafficTimingMeasure(
        'road-parse-total',
        _trafficTimingState,
        _trafficTimingParseStart,
        _trafficTimingParseEnd,
        { roadCount: 0 },
      );

      trafficTimingAggregate(
        'waypoint-materialization',
        _trafficTimingState,
        _trafficTimingParseStartTime,
        0,
        { roadCount: 0 },
      );
      /* TRACE_ONLY_END */
      return [];
    }

    const roads = [];
    /* TRACE_ONLY_BEGIN */
    let _trafficTimingWaypointMaterializationMs = 0;
    /* TRACE_ONLY_END */
    for (const road of roadData.roads) {
      if (!road.coordinates || road.coordinates.length < 2) continue;

      for (const coords of roadSurfaceChunks(road.coordinates)) {
        const type = road.type;
        const oneway = road.oneway;

        /* TRACE_ONLY_BEGIN */
        const _trafficTimingMaterializeStart = performance.now();
        /* TRACE_ONLY_END */
        const waypoints = coords.map(([lng, lat]) => {
          const floor = services.ground?.cachedGroundFloor?.(lat, lng);
          const h =
            (Number.isFinite(floor) && Math.abs(floor) <= 9000 ? floor : 0) +
            DOT_HEIGHT_OFFSET;
          return Cesium.Cartesian3.fromDegrees(lng, lat, h);
        });
        const segmentDist = [];
        for (let i = 0; i < waypoints.length - 1; i++) {
          segmentDist.push(
            Cesium.Cartesian3.distance(waypoints[i], waypoints[i + 1]),
          );
        }
        /* TRACE_ONLY_BEGIN */
        _trafficTimingWaypointMaterializationMs +=
          performance.now() - _trafficTimingMaterializeStart;
        /* TRACE_ONLY_END */

        for (const direction of oneway ? [oneway] : [1, -1])
          roads.push({
            densityWeight: oneway ? 1 : 0.5,
            coords,
            type,
            oneway: direction,
            waypoints,
            segmentDist,
            flow: road.flow || null,
          });
      }
    }
    /* TRACE_ONLY_BEGIN */
    const _trafficTimingMetrics = {
      roadCount: roads.length,
    };

    trafficTimingAggregate(
      'waypoint-materialization',
      _trafficTimingState,
      _trafficTimingParseStartTime,
      _trafficTimingWaypointMaterializationMs,
      _trafficTimingMetrics,
    );
    const _trafficTimingParseEnd = trafficTimingMark(
      _trafficTimingState,
      'road-parse-end',
      _trafficTimingMetrics,
    );
    trafficTimingMeasure(
      'road-parse-total',
      _trafficTimingState,
      _trafficTimingParseStart,
      _trafficTimingParseEnd,
      _trafficTimingMetrics,
    );
    /* TRACE_ONLY_END */
    return roads;
  }

  /** Resolve a render label into its correlated pass and data source. */

  function trafficTimingRenderState(trace, label) {
    const pass = label.toLowerCase().includes('major') ? 'major' : 'full';
    const source = label.startsWith('Cache') ? 'client-cache' : 'proxy';
    return trafficTimingPass(trace, pass, source);
  }

  /** Record the first Cesium postRender following a completed dot render. */

  function scheduleTrafficTimingPostRender(
    state,
    renderEnd,
    renderId,
    renderMetrics,
  ) {
    if (!layerState._viewer?.scene) return;
    let remove = null;
    remove = layerState._viewer.scene.postRender.addEventListener(() => {
      remove?.();
      layerState._trafficTimingPostRenderRemovers?.delete(remove);
      const visibleTime = performance.now();
      const postRender = trafficTimingMark(
        state,
        'next-post-render',
        {
          renderId,
          ...renderMetrics,
        },
        visibleTime,
      );
      const firstVisible = trafficTimingMark(
        state,
        'first-visible-pixel',
        {
          renderId,
          visibleBoundary: 'next-postRender',
          ...renderMetrics,
        },
        visibleTime,
      );
      trafficTimingMeasure(
        'render-to-post-render',
        state,
        renderEnd,
        postRender,
        {
          renderId,
          visibleBoundary: 'next-postRender',
          ...renderMetrics,
        },
      );
      trafficTimingMeasure(
        'last-camera-change-to-first-visible',
        state,
        state.trace.cameraChangeMark,
        firstVisible,
        { renderId, visibleBoundary: 'next-postRender', ...renderMetrics },
      );
    });
    layerState._trafficTimingPostRenderRemovers?.add(remove);
  }

  /** Start a scheduling-correlated debug trace, or count and drop an unpaired load. */

  async function loadRoadsForBoundsTimed(bounds, altitude, expectedAnchor) {
    const generation = layerState._loadGeneration + 1;
    if (
      !expectedAnchor ||
      expectedAnchor !== layerState._trafficTimingCurrentAnchor
    ) {
      layerState._trafficTimingDroppedTraces += 1;
      await parts.ingestion.loadRoadsForBounds(bounds, altitude);
      return;
    }
    layerState._trafficTimingCurrentAnchor = null;
    const clamped = parts.viewport.clampBounds(bounds);
    const trace = {
      id: ++layerState._trafficTimingSequence,
      interactionId: expectedAnchor.interactionId,
      cameraChangeTimestamp: expectedAnchor.timestamp,
      cameraChangeMark: trafficTimingCameraChangeMarkName(
        expectedAnchor.interactionId,
      ),
      generation,
      cacheKey: `${clamped.south.toFixed(4)},${clamped.west.toFixed(4)},${clamped.north.toFixed(4)},${clamped.east.toFixed(4)}`,
      currentPass: null,
      renderSequence: 0,
      passes: new Map(),
    };
    layerState._trafficTimingTracesCreated += 1;
    await parts.ingestion.loadRoadsForBounds(bounds, altitude, trace);
  }
  return {
    getTrafficTimingDiagnostics,
    trafficTimingPass,
    trafficTimingDetail,
    trafficTimingMark,
    trafficTimingMeasure,
    trafficTimingAggregate,
    clearTrafficTimingEntries,
    trafficTimingCameraChangeMarkName,
    markTrafficTimingCameraChange,
    markTrafficTimingMoveEnd,
    parseRoadsTimed,
    trafficTimingRenderState,
    scheduleTrafficTimingPostRender,
    loadRoadsForBoundsTimed,
  };
}
