import {
  trafficBucketTier,
  trafficStyleProfile,
} from '../../data/trafficPresetStyle.js';
import { TRAFFIC_TIMING_ENABLED } from './policy.js';

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
     * 'sim' (keyless simulation on live OSM roads). Health rides on the
     * structured provider fields (src/data/feedState.js): a probed keyless
     * deployment reads `status`/`providerStatus` 'degraded' with
     * `providerError` naming TOMTOM_API_KEY; a healthy keyed layer reads
     * `providerStatus` 'live' ('stale' while the proxy serves last-good
     * tiles); `error` carries a real fault — Overpass roads unavailable, the
     * status probe unreachable, a rejected key, a flow outage — so a
     * live-configured layer whose flow feed went down reads DEGRADED with the
     * reason instead of a stale LIVE coverage number. `flowCoveragePct` is
     * matched roads / roads with any flow candidates (0–100 int);
     * `tilesFetched` counts flow-tile requests issued to the proxy this
     * session (decode-cache hits excluded); `flowSegment` is the live-speed
     * sample the proxy probed at the scene point (keyed deployments only).
     * @returns {{count:number, lastUpdate:number|null, loading:boolean,
     *   mode:'live'|'sim', error:string|null, status:string|null,
     *   degraded:boolean, stale:boolean, providerStatus:string|null,
     *   providerSource:string, providerError:string|null, coverage:string,
     *   flowCoveragePct:number, tilesFetched:number, flowSegment:object|null}}
     */
    getStats() {
      // Outstanding flow work counts as loading: the paint race can leave a
      // TomTom request in flight after the roads have settled, and the shared
      // loading batch has to stay open long enough to announce its failure.
      const loading = layerState._fetching || layerState._flowPending > 0;
      const flowSession = getFlowSessionStats() || {};
      const feed = parts.model.trafficFeedPresentation({
        liveMode: layerState._liveMode,
        fetching: loading,
        flowError: layerState._flowError,
        coveragePct: layerState._flowCoveragePct,
        statusUnavailable: layerState._flowStatusUnavailable,
        statusResolved: layerState._flowStatusResolved,
        probeError: layerState._flowProbeError,
        flowProviderStatus: flowSession.provider?.status || null,
      });
      const roadError = layerState._roadError;
      // The road network failed with the proxy's structured DEGRADED status
      // (server/providers/overpass.js, 2026-09-19): present it exactly as the
      // other MOVEMENT proxies present a designed degradation — `status` /
      // `providerStatus` 'degraded', `providerError` = the proxy's reason,
      // source 'Overpass' — and NOT as `error`, which src/loadingFeedback.js
      // turns into a LOAD FAILED banner and src/data/feedState.js reads (with
      // no rendered roads) as UNAVAILABLE. The row therefore reads
      // `DEGRADED · Overpass · all 5 mirrors failed · last: …` while the
      // bounded retry keeps asking. A failure with no structured status (a
      // legacy proxy, a 400 the query itself earned) keeps the fault path.
      const roadDegraded = Boolean(
        roadError && layerState._roadProvider?.status === 'degraded',
      );
      // Named source for the row: the road feed when IT is the fault, else the
      // flow provider whenever the presented state is about it.
      const source = roadDegraded
        ? 'Overpass'
        : roadError
          ? 'OpenStreetMap'
          : feed.source;
      return {
        count: layerState._count,
        lastUpdate: layerState._lastUpdate,
        loading,
        mode: feed.mode,
        error: roadDegraded ? null : roadError || feed.error,
        ...(source ? { source } : {}),
        status: roadError ? 'degraded' : feed.status,
        degraded: Boolean(roadError) || feed.degraded,
        stale: feed.stale,
        providerStatus: roadDegraded ? 'degraded' : feed.providerStatus,
        providerSource: roadDegraded ? 'Overpass' : feed.providerSource,
        providerError: roadDegraded ? roadError : feed.providerError,
        providerFetchedAt:
          flowSession.provider?.fetchedAtMs ??
          layerState._flowProvider?.fetchedAtMs ??
          null,
        coverage: feed.coverage,
        flowCoveragePct: layerState._flowCoveragePct,
        tilesFetched: Number(flowSession.tilesFetched) || 0,
        // Live-speed sample from the status probe (`/api/tomtom/status?point=`):
        // { ok, currentSpeed, freeFlowSpeed, confidence, fetchedAt } — null
        // keyless or before the first probe.
        flowSegment: layerState._flowSegment,
        // Daily TomTom budgets as last reported by the proxy (diagnostics).
        flowBudget: layerState._flowBudget,
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
        // While the bounded retry re-asks the mirrors the row keeps its
        // DEGRADED · Overpass · <reason> line and only appends `retrying`.
        loadingLabel: roadDegraded ? 'retrying' : feed.loadingLabel,
      };
    },
  };

  return { methods };
}
