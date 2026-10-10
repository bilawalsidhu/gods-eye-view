import {
  normalizeRoadMode,
  resolveRoadMode,
  TRAFFIC_ROAD_MODES,
} from './roadModes.js';
import {
  trafficBucketTier,
  trafficStyleProfile,
} from '../../data/trafficPresetStyle.js';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';
import { t } from '../../i18n/index.js';

export function createControls({ state: layerState, services, parts, source }) {
  /** One status line: feed, drawn road source, then degraded-coverage notes. */
  function roadStatusLabel(feed) {
    const source = layerState._roadSource;
    if (layerState._roadError)
      return t('ground.traffic.status.unavailable', { source });
    const notes = [feed.loadingLabel];
    if (!layerState._liveMode || feed.error)
      notes.push(t('ground.traffic.status.roadsSource', { source }));
    // An explicit TomTom or Hybrid choice without a key draws OpenStreetMap.
    if (
      !layerState._liveMode &&
      ['tomtom', 'hybrid'].includes(layerState._roadMode)
    )
      notes.push(
        layerState._flowStatusUnavailable
          ? layerState._roadMode === 'tomtom'
            ? t('ground.traffic.status.serviceUnavailableTomTom')
            : t('ground.traffic.status.serviceUnavailableHybrid')
          : layerState._roadMode === 'tomtom'
            ? t('ground.traffic.status.tomtomNeedsKey')
            : t('ground.traffic.status.hybridNeedsKey'),
      );
    if (layerState._surfacePending)
      notes.push(t('ground.traffic.status.surfaceLoading'));
    if (layerState._roadWarning) notes.push(layerState._roadWarning);
    else if (layerState._roadPartial)
      notes.push(t('ground.traffic.status.partialCoverage'));
    if (layerState._detailError)
      notes.push(t('ground.traffic.status.detailError'));
    else if (layerState._detailLimited)
      notes.push(t('ground.traffic.status.detailLimited'));
    return notes.join(' · ');
  }

  const { getFlowSessionStats } = source;

  const methods = {
    id: 'traffic',

    name: 'Street Traffic',

    icon: '🚗',

    source: 'OpenStreetMap / TomTom',

    /** @type {number} Zero — layer is self-managed via camera listener + preRender */
    updateInterval: 0,

    /**
     * Update user-adjustable parameters (road source, density and speed scaling).
     *
     * @param {Object}  [params]
     * @param {'tomtom'|'osm'|'hybrid'|null} [params.roadMode] - Road source; null = default.
     * @param {number}  [params.densityScale] - Dot density multiplier (clamped 0.2–2.5).
     * @param {number}  [params.speedScale]   - Dot speed multiplier (clamped 0.3–3.0).
     * @param {{origin?:string}} [options] - Intent origin; restores never beat `?trafficRoads=`.
     */
    setParams(params = {}, { origin } = {}) {
      const previousDensity = layerState._densityScale;
      const previousSpeed = layerState._speedScale;
      if (
        Object.hasOwn(params, 'roadMode') &&
        (params.roadMode === null || normalizeRoadMode(params.roadMode))
      ) {
        const explicit = ['user', 'voice', 'tool'].includes(origin);
        const mode =
          !explicit && layerState._roadModeUrlOverride
            ? layerState._roadModeUrlOverride
            : params.roadMode;
        if (explicit) layerState._roadModeUrlOverride = null;
        if (mode !== layerState._roadMode) {
          layerState._roadMode = mode;
          // Redraw from scratch: a different source means different roads.
          parts.ingestion.cancelActiveFetch();
          clearTimeout(layerState._retryTimer);
          layerState._retryTimer = null;
          layerState._loadGeneration++;
          layerState._fetching = false;
          layerState._lastBounds = null;
          layerState._lastViewCenter = null;
          parts.animation.clearDots();
          if (layerState._enabled)
            parts.viewport.onCameraChanged({ immediate: true });
        }
      }
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
      if (layerState._speedScale !== previousSpeed) {
        const ratio = layerState._speedScale / previousSpeed;
        for (const dot of layerState._dots) {
          dot.baseMps *= ratio;
          dot.mps *= ratio;
        }
      }
      if (
        layerState._densityScale !== previousDensity &&
        layerState._enabled &&
        layerState._roads.length
      )
        parts.rendering.renderRoadsForAltitude(
          layerState._roads,
          layerState._lastRenderAltitude,
          'Density',
        );
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
        roadMode: layerState._roadMode,
        densityScale: layerState._densityScale,
        speedScale: layerState._speedScale,
        uncoveredRoads: layerState._uncoveredMode,
        jamViz: layerState._jamViz,
        presetDots: layerState._presetDots,
      };
    },

    /** Road-source chips on the Street Traffic row (TomTom / OSM / Hybrid). */
    getRowControls() {
      const selected =
        layerState._roadMode || resolveRoadMode(null, layerState._liveMode);
      const needsKey = layerState._liveMode
        ? ''
        : t('ground.traffic.chips.needsKeySuffix');
      const titles = {
        tomtom: t('ground.traffic.chips.tomtomTitle', { suffix: needsKey }),
        osm: t('ground.traffic.chips.osmTitle'),
        hybrid: t('ground.traffic.chips.hybridTitle', { suffix: needsKey }),
      };
      const labels = { tomtom: 'TomTom', osm: 'OSM', hybrid: 'Hybrid' };
      return {
        chips: TRAFFIC_ROAD_MODES.map((mode) => ({
          id: `roads-${mode}`,
          label: labels[mode],
          title: titles[mode],
          active: mode === selected,
          params: { roadMode: mode },
        })),
      };
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
      if (!layerState._enabled || layerState._dots.length === 0) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : layerState._dots.length;
      const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
      // Stride-based sampling: step through dots evenly to get ~maxCount samples
      const stride = Math.max(1, Math.ceil(layerState._dots.length / maxCount));
      const start = seed % stride;

      const result = [];
      for (let i = start; i < layerState._dots.length; i += stride) {
        const pos = layerState._dots[i].point.position;
        if (!pos) continue;
        const entry = {
          position: pos,
          id: `VEH-${String(layerState._dots[i].id).padStart(4, '0')}`,
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

    /** Visit stable dot identities and their owning geometry without allocating snapshots. */
    visitMotionDots(visitor) {
      for (let i = 0; i < layerState._dots.length; i++) {
        const dot = layerState._dots[i];
        visitor(dot.id, dot.road.key, dot.point, dot.road);
      }
    },

    /**
     * Return current layer statistics for UI status chips.
     * `mode` is the CONFIGURED source — 'live' (a TomTom key is present) or
     * 'sim' (keyless simulation, which the manager renders as a FALLBACK chip);
     * `error` carries this instant's health, so a live-configured layer whose
     * flow feed went down reads DEGRADED with the reason instead of a stale
     * LIVE coverage number. `flowCoveragePct` is shown dots on matched roads /
     * all shown dots (0–100 int), excluding closures; `tilesFetched` counts flow-tile requests
     * issued to the proxy this session (decode-cache hits excluded).
     * @returns {{count:number, lastUpdate:number|null, loading:boolean,
     *   mode:'live'|'sim', error:string|null, flowCoveragePct:number,
     *   tilesFetched:number}}
     */
    getLoadingDiagnostics() {
      let movingWaypoints = 0,
        maxResidualM = 0;
      for (const road of layerState._roads) {
        if (!road.heightMoving) continue;
        for (let i = 0; i < road.waypoints.length; i++) {
          const a = road.waypoints[i],
            b = road.targetWaypoints[i];
          const residual = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          if (residual >= 0.01) movingWaypoints++;
          maxResidualM = Math.max(maxResidualM, residual);
        }
      }
      return {
        fetching: Boolean(layerState._fetching),
        flowPending: layerState._flowPending,
        surfaceRefining: Boolean(layerState._surfaceRefining),
        populationPending: Boolean(layerState._populationPending),
        heightPending: Boolean(layerState._heightPending),
        generation: layerState._loadGeneration,
        surfaceRevision: layerState._surfaceRevision,
        lastPaintStage: layerState._lastPaintStage || null,
        movingWaypoints,
        maxResidualM,
      };
    },

    getStats() {
      // Outstanding flow work counts as loading: the paint race can leave a
      // TomTom request in flight after the roads have settled, and the shared
      // loading batch has to stay open long enough to announce its failure.
      const loading =
        layerState._fetching ||
        layerState._flowPending > 0 ||
        Boolean(layerState._surfaceRefining) ||
        Boolean(layerState._populationPending) ||
        Boolean(layerState._heightPending);
      const { free, slow, jam, sim } = layerState._bucketCounts;
      const matched = free + slow + jam;
      const flowCoveragePct =
        matched + sim > 0 ? Math.round((100 * matched) / (matched + sim)) : 0;
      const feed = parts.model.trafficFeedPresentation({
        liveMode: layerState._liveMode,
        fetching: loading,
        flowError: layerState._flowError,
        coveragePct: flowCoveragePct,
        statusUnavailable: layerState._flowStatusUnavailable,
        roadSource: layerState._roadSource,
      });
      return {
        count: layerState._count,
        motion: { ...layerState._motion },
        surfaceBudgetOmitted: layerState._surfaceBudgetOmitted || 0,
        lastUpdate: layerState._lastUpdate,
        loading,
        mode: feed.mode,
        error:
          layerState._roadError ||
          layerState._roadWarning ||
          layerState._detailError ||
          feed.error,
        roadBounds: layerState._lastBounds,
        surfacePending: layerState._surfacePending || 0,
        roadWarning: layerState._roadWarning || null,
        detailError: layerState._detailError || null,
        detailLimited: Boolean(layerState._detailLimited),
        flowCoveragePct,
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
        roadMode: resolveRoadMode(layerState._roadMode, layerState._liveMode),
        roadModeRequested: layerState._roadMode,
        roadSource: layerState._roadSource,
        source: layerState._roadSource,
        loadingLabel: roadStatusLabel(feed),
      };
    },
  };

  return { methods };
}
