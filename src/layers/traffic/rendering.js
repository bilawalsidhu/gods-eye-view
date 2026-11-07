import * as geo from '../../geo/index.js';
import { Rgba, WHITE } from '../shared/color.js';
import { flowBucket } from '../../data/trafficFlowStyle.js';
import { trafficStyleProfile } from '../../data/trafficPresetStyle.js';
import {
  HEAT_LINE_CAP,
  HEAT_JAM_COLOR,
  HEAT_SLOW_COLOR,
  HEAT_LINE_JAM_WIDTH,
  HEAT_JAM_BASE_ALPHA,
  HEAT_LINE_SLOW_WIDTH,
  TRAFFIC_TIMING_ENABLED,
} from './policy.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * At high altitude only major roads render — shared by the render pass and
   * the late-flow heat-line rebuild so lines never mark roads without dots.
   * @param {Array} roads    - Parsed road objects.
   * @param {number} altitude - Camera altitude in meters.
   * @returns {Array} The roads visible at this altitude.
   */

  function visibleRoadsForAltitude(roads, altitude) {
    return altitude > 5000
      ? roads.filter(
          (r) =>
            r.type === 'motorway' || r.type === 'trunk' || r.type === 'primary',
        )
      : roads;
  }

  /** Remove both heat-line sets from the display. */

  function removeHeatLines() {
    layerState._display?.clearHeat();
    layerState._heatLineCount = 0;
  }

  /**
   * Rebuild the congestion heat-line underlay (jam-viz heatline prototype):
   * slow/jam roads drape a corridor line onto the rendered 3D tiles — red for
   * jam, faint flat amber for slow — with the dots animating on top. One
   * display set per bucket. Capped at HEAT_LINE_CAP (jam first, longest
   * first); overflow is logged. No-op in sim mode, when the heatline mode is
   * off, or without a display.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildHeatLines(roads) {
    removeHeatLines();
    if (
      !layerState._display ||
      !layerState._liveMode ||
      !parts.style.heatlineOn()
    )
      return;

    const candidates = [];
    for (const road of roads) {
      const flow = road.flow;
      if (!flow || flow.closure) continue;
      const bucket = flowBucket(flow.level);
      if (bucket === 'free') continue;
      let len = 0;
      for (const d of road.segmentDist) len += d;
      candidates.push({ road, bucket, len });
    }
    candidates.sort((a, b) =>
      a.bucket === b.bucket ? b.len - a.len : a.bucket === 'jam' ? -1 : 1,
    );
    const kept = candidates.slice(0, HEAT_LINE_CAP);

    // Mono presets (NVG/FLIR/noir) discard hue — heat-lines re-encode in
    // luminance like the dots: jam = white, slow = faint gray.
    const monoHeat =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const jamLineColor = monoHeat ? WHITE : HEAT_JAM_COLOR;
    const slowLineColor = monoHeat
      ? new Rgba(0.7, 0.7, 0.7, HEAT_SLOW_COLOR.alpha)
      : HEAT_SLOW_COLOR;
    const roadsFor = (bucket) =>
      kept.filter((item) => item.bucket === bucket).map((item) => item.road);
    layerState._display.setHeat('jam', roadsFor('jam'), {
      color: jamLineColor.withAlpha(HEAT_JAM_BASE_ALPHA).rgba(),
      widthPx: HEAT_LINE_JAM_WIDTH,
    });
    layerState._display.setHeat('slow', roadsFor('slow'), {
      color: slowLineColor.rgba(),
      widthPx: HEAT_LINE_SLOW_WIDTH,
    });

    layerState._heatLineCount = kept.length;
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] Heat-lines capped at ${HEAT_LINE_CAP} (${candidates.length} congested roads in view)`,
      );
    }
  }

  /**
   * Reconcile road populations without respawning retained dots.
   *
   * When zoomed out (>5 km), only major road types are rendered to reduce clutter.
   * Dot budgets are allocated fairly across visible roads via `allocateRoadDotBudgets`.
   *
   * @param {Array} roads    - Parsed road objects to render.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label    - Logging label (e.g. "Cache full", "Loaded major").
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   */

  function renderRoadsForAltitude(
    roads,
    altitude,
    label,
    trace = null,
    replace = true,
  ) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingRenderState(trace, label)
        : null;
    const renderId = state ? ++trace.renderSequence : null;

    layerState._lastPaintStage = label;
    layerState._lastRenderAltitude = altitude;

    // At high altitude, drop minor roads to reduce visual noise
    const filteredRoads = visibleRoadsForAltitude(roads, altitude);

    // Closed roads spawn zero dots (computeDotCount/spawnDotsForRoad) — count
    // them here so the closure signal is visible in stats even at zero dots.
    layerState._closedRoads = layerState._liveMode
      ? filteredRoads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0)
      : 0;

    // Fade distances must track the camera-to-AREA distance, not assume a
    // nadir view: oblique pitches put the loaded roads many km away even at
    // low altitude. Probe three roads and stretch the curves accordingly.
    let areaDist = altitude;
    if (layerState._engine && filteredRoads.length) {
      const probes = [
        filteredRoads[0],
        filteredRoads[Math.floor(filteredRoads.length / 2)],
        filteredRoads[filteredRoads.length - 1],
      ];
      for (const probe of probes) {
        const wp = probe?.waypoints?.[0];
        if (wp)
          areaDist = Math.max(
            areaDist,
            geo.cartesian3.distance(layerState._engine.camera.livePosition, wp),
          );
      }
    }
    layerState._fadeScaleFar = Math.max(8000, areaDist * 1.5);
    layerState._fadeTransFar = Math.max(10000, areaDist * 1.8);

    const dotStart = state
      ? parts.timing.trafficTimingMark(state, 'dot-construction-start', {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
        })
      : null;
    parts.retention.reconcile(filteredRoads, altitude, replace);
    if (layerState._dots.length && filteredRoads.some((r) => !r.directFlow))
      services.credits?.showOsmCredit?.(layerState._engine, 'traffic', {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(layerState._engine, 'traffic');
    parts.model.recolorDotsInPlace(label);

    const renderMetrics = state
      ? {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
          dotCount: layerState._dots.length,
        }
      : null;
    if (state) {
      const dotEnd = parts.timing.trafficTimingMark(
        state,
        'dot-construction-end',
        renderMetrics,
      );
      parts.timing.trafficTimingMeasure(
        'dot-construction',
        state,
        dotStart,
        dotEnd,
        renderMetrics,
      );
    }

    const heatStart = state
      ? parts.timing.trafficTimingMark(
          state,
          'rebuild-heat-lines-start',
          renderMetrics,
        )
      : null;
    if (!label.includes('tile')) rebuildHeatLines(filteredRoads);
    if (state) {
      const heatEnd = parts.timing.trafficTimingMark(
        state,
        'rebuild-heat-lines-end',
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
      parts.timing.trafficTimingMeasure(
        'rebuild-heat-lines',
        state,
        heatStart,
        heatEnd,
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
    }

    parts.retention.refreshCounts();
    layerState._lastUpdate = Date.now();
    console.log(
      `[Data:Traffic] ${label}: ${layerState._count} dots (roads=${roads.length}, alt=${Math.round(altitude)}m)`,
    );
    if (state) {
      const renderEnd = parts.timing.trafficTimingMark(
        state,
        'render-return',
        renderMetrics,
      );
      parts.timing.scheduleTrafficTimingPostRender(
        state,
        renderEnd,
        renderId,
        renderMetrics,
      );
    }
  }
  return {
    visibleRoadsForAltitude,
    removeHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
