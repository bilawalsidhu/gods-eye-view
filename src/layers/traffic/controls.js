import * as Cesium from 'cesium';
import {
  trafficBucketTier,
  trafficStyleProfile,
} from '../../data/trafficPresetStyle.js';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';

/**
 * Find the nearest point on the currently loaded road polylines.
 * @param {Array<{coords:number[][],type?:string}>} roads Parsed traffic roads.
 * @param {{lat:number,lon:number}} point Geographic observation.
 * @param {number} [maxDistanceM=18] Admission radius.
 * @returns {{lat:number,lon:number,distanceM:number,roadIndex:number,segmentIndex:number,t:number,roadType:string|null}|null}
 */
export function nearestRoadSnap(roads, point, maxDistanceM = 18) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  const maxDistance = Math.max(1, Number(maxDistanceM) || 18);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const metresLat = 111320;
  const metresLon = Math.max(1, metresLat * Math.cos((lat * Math.PI) / 180));
  let best = null;
  for (let roadIndex = 0; roadIndex < (roads || []).length; roadIndex++) {
    const road = roads[roadIndex];
    const coords = road?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    for (
      let segmentIndex = 0;
      segmentIndex < coords.length - 1;
      segmentIndex++
    ) {
      const a = coords[segmentIndex];
      const b = coords[segmentIndex + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const ax = (Number(a[0]) - lon) * metresLon;
      const ay = (Number(a[1]) - lat) * metresLat;
      const bx = (Number(b[0]) - lon) * metresLon;
      const by = (Number(b[1]) - lat) * metresLat;
      if (![ax, ay, bx, by].every(Number.isFinite)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq <= 1e-6) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
      const x = ax + dx * t;
      const y = ay + dy * t;
      const distanceM = Math.hypot(x, y);
      if (distanceM > maxDistance || (best && distanceM >= best.distanceM))
        continue;
      best = {
        lat: lat + y / metresLat,
        lon: lon + x / metresLon,
        distanceM,
        roadIndex,
        segmentIndex,
        t,
        roadType: road.type || null,
      };
    }
  }
  return best;
}

export function createControls({ state: layerState, services, parts, source }) {
  const { getFlowSessionStats } = source;

  const methods = {
    id: 'traffic',

    name: 'Street Traffic',

    icon: '🚗',

    source: 'OpenStreetMap',

    /** @type {number} Zero — layer is self-managed via camera listener + preRender */
    updateInterval: 0,

    /**
     * Update user-adjustable parameters (density and speed scaling).
     *
     * @param {Object}  [params]
     * @param {number}  [params.densityScale] - Dot density multiplier (clamped 0.2–2.5).
     * @param {number}  [params.speedScale]   - Dot speed multiplier (clamped 0.3–3.0).
     */
    setParams(params = {}) {
      if (typeof params.densityScale === 'number') {
        layerState._densityScale = Math.max(
          0.2,
          Math.min(2.5, params.densityScale),
        );
      }
      if (typeof params.speedScale === 'number') {
        layerState._speedScale = Math.max(
          0.3,
          Math.min(3.0, params.speedScale),
        );
      }
      // Live-mode treatment of roads TomTom has no flow data for:
      // 'sim' (default) keeps them as today's white ambient dots — colored =
      // real data, white = simulation; 'hide' spawns nothing on them (strict
      // data-integrity view). Owner-explorable; re-render applies on the next
      // camera-driven load.
      if (params.uncoveredRoads === 'sim' || params.uncoveredRoads === 'hide') {
        layerState._uncoveredMode = params.uncoveredRoads;
      }
      // Jam-viz prototype toggle (owner A/B): 'none' = shipped main behavior;
      // live mode only, applies on the next camera-driven load like the
      // uncoveredRoads param above.
      if (['none', 'density', 'heatline', 'both'].includes(params.jamViz)) {
        layerState._jamViz = params.jamViz;
      }
      // Preset-aware dot styling kill switch (owner A/B): 'off' forces the
      // shipped palette under every post-FX preset. Applies immediately via
      // in-place restyle — no refetch — so A/B legs share identical dots.
      if (params.presetDots === 'on' || params.presetDots === 'off') {
        if (params.presetDots !== layerState._presetDots) {
          layerState._presetDots = params.presetDots;
          parts.style.restyleDotsInPlace();
        }
      }
    },

    /**
     * Return the current user-adjustable parameters.
     * @returns {{densityScale:number, speedScale:number}}
     */
    getParams() {
      return {
        densityScale: layerState._densityScale,
        speedScale: layerState._speedScale,
        uncoveredRoads: layerState._uncoveredMode,
        jamViz: layerState._jamViz,
        presetDots: layerState._presetDots,
      };
    },

    /**
     * Snap a CCTV-derived observation onto nearby loaded road geometry.
     * Returns the interpolated rendered-road Cartesian so observed contacts use
     * the same height datum as normal traffic dots.
     * @param {{lat:number,lon:number}} point
     * @param {{maxDistanceM?:number}} [options]
     * @returns {Object|null}
     */
    snapObservedPoint(point, options = {}) {
      const snap = nearestRoadSnap(
        layerState._roads,
        point,
        options.maxDistanceM,
      );
      if (!snap) return null;
      const road = layerState._roads[snap.roadIndex];
      const a = road?.waypoints?.[snap.segmentIndex];
      const b = road?.waypoints?.[snap.segmentIndex + 1];
      const position =
        a && b
          ? Cesium.Cartesian3.lerp(a, b, snap.t, new Cesium.Cartesian3())
          : Cesium.Cartesian3.fromDegrees(snap.lon, snap.lat, 2);
      return { ...snap, position };
    },

    /** Replace one producer's anonymous transient observed contacts. */
    replaceExternalVehicleObservations(sourceId, contacts, options = {}) {
      return parts.rendering.replaceExternalVehicleObservations(
        sourceId,
        contacts,
        options,
      );
    },

    /** Clear one producer, or every external observation when sourceId is null. */
    clearExternalVehicleObservations(sourceId = null) {
      return parts.rendering.clearExternalVehicleObservations(sourceId);
    },

    /**
     * Return a sub-sampled list of active dot positions for detection overlays
     * (e.g. CCTV bounding-box rendering).
     *
     * Uses a deterministic stride-based sampling so different seeds yield
     * non-overlapping subsets without sorting or shuffling.
     *
     * @param {Object}  [options]
     * @param {number}  [options.maxCount] - Maximum objects to return (defaults to all).
     * @param {number}  [options.seed]     - Integer seed to offset the sampling start.
     * @returns {Array<{position:Cesium.Cartesian3, id:string, type:string}>}
     */
    getDetectableObjects(options = {}) {
      if (!layerState._enabled) return [];
      const observed = parts.rendering.getExternalVehicleDetectableObjects();
      if (!layerState._dots.length && !observed.length) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : layerState._dots.length + observed.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      // Stride-based sampling: step through dots evenly to get ~maxCount samples
      const stride = Math.max(1, Math.ceil(layerState._dots.length / maxCount));
      const start = seed % stride;

      const result = observed.slice(0, maxCount);
      if (result.length >= maxCount) return result;
      for (let i = start; i < layerState._dots.length; i += stride) {
        const pos = layerState._dots[i].point.position;
        if (!pos) continue;
        const entry = {
          position: pos,
          id: `VEH-${String(i).padStart(4, '0')}`,
          type: 'VEH',
        };
        // Live mode: the detection bracket carries the congestion signal —
        // its canvas sits ABOVE the post-FX chain, so tier colors survive
        // every preset (owner round 2: "bounding boxes do the heavy
        // lifting"). Keyless mode sets no tier: contacts keep the stock
        // 'vehicle' bracket and the keyless experience stays untouched.
        if (layerState._liveMode) {
          const tier = trafficBucketTier(layerState._dots[i].bucket || 'sim');
          if (tier) entry.tier = tier;
        }
        result.push(entry);
        if (result.length >= maxCount) break;
      }
      return result;
    },

    /**
     * Return current layer statistics for UI status chips.
     * `mode` is the CONFIGURED source — 'live' (a TomTom key is present) or
     * 'sim' (keyless simulation, which the manager renders as a FALLBACK chip);
     * `error` carries this instant's health, so a live-configured layer whose
     * flow feed went down reads DEGRADED with the reason instead of a stale
     * LIVE coverage number. `flowCoveragePct` is matched roads / roads with any
     * flow candidates (0–100 int); `tilesFetched` counts flow-tile requests
     * issued to the proxy this session (decode-cache hits excluded).
     * @returns {{count:number, lastUpdate:number|null, loading:boolean,
     *   mode:'live'|'sim', error:string|null, flowCoveragePct:number,
     *   tilesFetched:number}}
     */
    getStats() {
      // Outstanding flow work counts as loading: the paint race can leave a
      // TomTom request in flight after the roads have settled, and the shared
      // loading batch has to stay open long enough to announce its failure.
      const loading = layerState._fetching || layerState._flowPending > 0;
      const feed = parts.model.trafficFeedPresentation({
        liveMode: layerState._liveMode,
        fetching: loading,
        flowError: layerState._flowError,
        coveragePct: layerState._flowCoveragePct,
        statusUnavailable: layerState._flowStatusUnavailable,
      });
      return {
        count: layerState._count,
        observedVehicles: parts.rendering.getExternalVehicleObservationCount(),
        lastUpdate: layerState._lastUpdate,
        loading,
        mode: feed.mode,
        error: layerState._roadError || feed.error,
        flowCoveragePct: layerState._flowCoveragePct,
        tilesFetched: getFlowSessionStats().tilesFetched,
        ...(TRAFFIC_TIMING_ENABLED
          ? { trafficTiming: parts.timing.getTrafficTimingDiagnostics() }
          : {}),
        // Per-bucket rendered-dot counts (sim = white ambient). Drives the
        // qa-traffic color assertions and the sync-chip mode label below.
        flowBuckets: { ...layerState._bucketCounts },
        closedRoads: layerState._closedRoads,
        // Jam-viz prototype diagnostics (additive — harness contract untouched).
        heatLines: layerState._heatLineCount,
        jamViz: layerState._jamViz,
        // Preset-styling diagnostics (additive): active style + profile.
        stylePreset: layerState._stylePreset,
        styleProfile:
          layerState._presetDots === 'on'
            ? trafficStyleProfile(layerState._stylePreset)
            : 'normal',
        // Sync-chip text: shown while busy, and flashed on its own for 1.5 s
        // after each completed load (ui.js _updateTrafficSyncChip semantics).
        // The settled flash carries NO progress number beside it — this label's
        // coverage figure is the chip's only percentage — so a label that ends
        // in one had better be the honest one. This is also where LIVE vs
        // SIMULATED mode is surfaced, and it must never imply a live feed the
        // layer does not have.
        loadingLabel: feed.loadingLabel,
      };
    },
  };

  return { methods };
}
