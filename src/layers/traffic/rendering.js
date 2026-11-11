import * as geo from '../../geo/index.js';
import { Rgba, WHITE } from '../shared/color.js';
import { flowBucket } from '../../data/trafficFlowStyle.js';
import { trafficStyleProfile } from '../../data/trafficPresetStyle.js';
import {
  FLOW_BUCKET_COLORS,
  FLOW_LINE_ALPHA,
  FLOW_LINE_CAP,
  FLOW_LINE_WIDTH,
  HEAT_LINE_CAP,
  HEAT_JAM_COLOR,
  HEAT_SLOW_COLOR,
  HEAT_LINE_JAM_WIDTH,
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_GLOW_POWER,
  HEAT_JAM_PULSE_ALPHA,
  HEAT_JAM_PULSE_PERIOD_MS,
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

  function removeSets(sets) {
    for (const set of sets) set.destroy();
  }

  /** Remove the heat-line / flow-line ground sets from the display. */

  function removeHeatLines() {
    layerState._heatPendingRoads = null;
    layerState._display?.clearHeat();
    layerState._heatLineCount = 0;
    removeSets(layerState._heatRetired || []);
    layerState._heatRetired = [];
    parts.animation?.syncRenderDemand?.();
  }

  /** @returns {boolean} Whether a line primitive's geometry is still building. */

  function linesBuilding() {
    return layerState._display?.heatBuilding() ?? false;
  }

  /**
   * Replaced lines stay drawn until their successors finish building
   * (ground geometry can build asynchronously), so a rebuild never
   * blinks. Once they have, the replaced lines go and the newest rebuild
   * asked for in the meantime starts. Called every held frame.
   */

  function retireHeatLines() {
    if (linesBuilding()) return;
    if (layerState._heatRetired?.length) {
      removeSets(layerState._heatRetired);
      layerState._heatRetired = [];
    }
    const pending = layerState._heatPendingRoads;
    if (pending) {
      layerState._heatPendingRoads = null;
      rebuildHeatLines(pending);
    }
  }

  /**
   * Rebuild the road-line underlay drawn from live flow, in one of two looks:
   *
   * - Flow lines (the `lines` row toggle): every road with flow drapes a
   *   steady line in its bucket color — green free-flow, amber slow, red jam.
   *   Capped at FLOW_LINE_CAP.
   * - Heat-lines (jam-viz `heatline` prototype): only slow/jam roads, a
   *   glowing pulsing red for jam and a faint flat amber for slow. Capped at
   *   HEAT_LINE_CAP.
   *
   * One ground corridor set per bucket; the engine animates the jam pulse.
   * Kept roads are jam first, then slow,
   * then free, longest first; overflow is logged. Lines drape on 3D tiles when
   * the globe is hidden (photoreal) and on terrain or tiles otherwise. No-op in
   * sim mode, when both looks are off, or without ground-primitive support.
   *
   * One build runs at a time. A city loads in progressive paints, each asking
   * for a rebuild, and every build drapes up to the cap of polylines
   * asynchronously. A rebuild asked for while lines are building only replaces
   * the one waiting, which retireHeatLines starts when the build finishes, so
   * the scene never holds more than the lines drawn and the lines building.
   * Turning the lines off is never deferred.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildHeatLines(roads) {
    const wanted =
      layerState._display && layerState._liveMode && parts.style.heatlineOn();
    if (wanted && linesBuilding()) {
      layerState._heatPendingRoads = roads;
      return;
    }
    layerState._heatPendingRoads = null;
    // Retired sets no longer have a build to wait for, so they go before the
    // next one starts. At most the drawn set and its successor remain.
    removeSets(layerState._heatRetired || []);
    layerState._heatRetired = [];
    const previous = layerState._display?.takeHeat() || [];
    layerState._heatLineCount = 0;
    const finish = () => {
      if (layerState._heatLineCount) layerState._heatRetired.push(...previous);
      else removeSets(previous);
      parts.animation?.syncRenderDemand?.();
    };
    if (!wanted) return finish();

    const flowLines = layerState._showLines;
    const cap = flowLines ? FLOW_LINE_CAP : HEAT_LINE_CAP;
    const rank = { jam: 0, slow: 1, free: 2 };
    const candidates = [];
    for (const road of roads) {
      const flow = road.flow;
      if (!flow || flow.closure) continue;
      const bucket = flowBucket(flow.level);
      if (bucket === 'free' && !flowLines) continue;
      let len = 0;
      for (const d of road.segmentDist) len += d;
      candidates.push({ road, bucket, len });
    }
    candidates.sort((a, b) =>
      a.bucket === b.bucket ? b.len - a.len : rank[a.bucket] - rank[b.bucket],
    );
    const kept = candidates.slice(0, cap);

    // Mono presets discard hue: jam = white, slow = gray, free = dim gray.
    const mono =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const gray = (level, alpha) => new Rgba(level, level, level, alpha);
    const roadsFor = (bucket) =>
      kept.filter((item) => item.bucket === bucket).map((item) => item.road);
    if (flowLines) {
      const dotColor = (bucket) =>
        layerState._activeBucketColors?.[bucket] || FLOW_BUCKET_COLORS[bucket];
      const lineColor = {
        jam: mono ? gray(1, FLOW_LINE_ALPHA) : dotColor('jam'),
        slow: mono ? gray(0.7, FLOW_LINE_ALPHA) : dotColor('slow'),
        free: mono ? gray(0.45, FLOW_LINE_ALPHA) : dotColor('free'),
      };
      for (const [order, bucket] of ['free', 'slow', 'jam'].entries())
        layerState._display.setHeat(bucket, roadsFor(bucket), {
          color: lineColor[bucket].withAlpha(FLOW_LINE_ALPHA).rgba(),
          widthPx: FLOW_LINE_WIDTH,
          drape: layerState._engine?.maps.photorealActive() ? 'tiles' : 'both',
          order,
        });
    } else {
      const jamLineColor = mono ? WHITE : HEAT_JAM_COLOR;
      const slowLineColor = mono
        ? gray(0.7, HEAT_SLOW_COLOR.alpha)
        : HEAT_SLOW_COLOR;
      layerState._display.setHeat('jam', roadsFor('jam'), {
        color: jamLineColor.withAlpha(1).rgba(),
        widthPx: HEAT_LINE_JAM_WIDTH,
        glow: { power: HEAT_JAM_GLOW_POWER },
        pulse: {
          periodMs: HEAT_JAM_PULSE_PERIOD_MS,
          min: HEAT_JAM_BASE_ALPHA - HEAT_JAM_PULSE_ALPHA,
          max: HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA,
        },
      });
      layerState._display.setHeat('slow', roadsFor('slow'), {
        color: slowLineColor.rgba(),
        widthPx: HEAT_LINE_SLOW_WIDTH,
      });
    }

    layerState._heatLineCount = kept.length;
    finish();
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] ${flowLines ? 'Flow lines' : 'Heat-lines'} capped at ${cap} (${candidates.length} roads in view)`,
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
    // The flow recolor above already rebuilt the lines from every retained
    // road; without dots to recolor, rebuild them here.
    if (
      !label.includes('tile') &&
      !(layerState._liveMode && layerState._dots.length)
    )
      rebuildHeatLines(visibleRoadsForAltitude(layerState._roads, altitude));
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
    linesBuilding,
    retireHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
