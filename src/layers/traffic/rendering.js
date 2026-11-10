import * as Cesium from 'cesium';
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

  const LINE_KEYS = ['_heatJamPrim', '_heatSlowPrim', '_heatFreePrim'];

  /** Detach the current line primitives, leaving them in the scene. */
  function takeHeatLines() {
    const taken = [];
    for (const key of LINE_KEYS) {
      if (layerState[key]) taken.push(layerState[key]);
      layerState[key] = null;
    }
    layerState._heatLineCount = 0;
    return taken;
  }

  function removePrimitives(primitives) {
    for (const primitive of primitives)
      layerState._viewer?.scene.groundPrimitives.remove(primitive);
  }

  /** Remove the heat-line / flow-line ground primitives from the scene. */

  function removeHeatLines() {
    layerState._heatPendingRoads = null;
    removePrimitives(takeHeatLines());
    removePrimitives(layerState._heatRetired || []);
    layerState._heatRetired = [];
    parts.animation.syncRenderDemand?.();
  }

  /** @returns {boolean} Whether a line primitive's geometry is still building. */

  function linesBuilding() {
    return LINE_KEYS.some((key) => layerState[key] && !layerState[key].ready);
  }

  /**
   * Replaced lines stay drawn until their successors finish building
   * (GroundPolylinePrimitive geometry is asynchronous), so a rebuild never
   * blinks. Once they have, the replaced lines go and the newest rebuild
   * asked for in the meantime starts. Called every held frame.
   */

  function retireHeatLines() {
    if (linesBuilding()) return;
    if (layerState._heatRetired?.length) {
      removePrimitives(layerState._heatRetired);
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
   * One batched GroundPolylinePrimitive per bucket, so the heat-line jam batch
   * pulses through one shared material. Kept roads are jam first, then slow,
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
      layerState._viewer && layerState._liveMode && parts.style.heatlineOn();
    if (wanted && linesBuilding()) {
      layerState._heatPendingRoads = roads;
      return;
    }
    layerState._heatPendingRoads = null;
    // No build is left for replaced lines to wait for (it finished, or lines
    // are going off), so they go first and never pile up behind this rebuild.
    removePrimitives(layerState._heatRetired || []);
    layerState._heatRetired = [];
    const previous = takeHeatLines();
    const finish = () => {
      if (LINE_KEYS.some((key) => layerState[key]))
        (layerState._heatRetired ||= []).push(...previous);
      // Nothing new to wait for: the old lines go now.
      else removePrimitives(previous);
      parts.animation.syncRenderDemand?.();
    };
    if (!wanted) return finish();
    if (layerState._heatSupported === null) {
      layerState._heatSupported = Cesium.GroundPolylinePrimitive.isSupported(
        layerState._viewer.scene,
      );
      if (!layerState._heatSupported)
        console.warn(
          '[Data:Traffic] GroundPolylinePrimitive unsupported — heat-lines disabled',
        );
    }
    if (!layerState._heatSupported) return finish();

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

    const instancesFor = (bucket, width) =>
      kept
        .filter((c) => c.bucket === bucket)
        .map(
          (c) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                positions: c.road.waypoints,
                width,
              }),
            }),
        );

    // Mono presets (NVG/FLIR/noir) discard hue — lines re-encode in
    // luminance like the dots: jam = white, slow = gray, free = dim gray.
    const mono =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const gray = (level, alpha) => new Cesium.Color(level, level, level, alpha);
    const classificationType =
      layerState._viewer.scene.globe?.show === false
        ? Cesium.ClassificationType.CESIUM_3D_TILE
        : flowLines
          ? Cesium.ClassificationType.BOTH
          : Cesium.ClassificationType.CESIUM_3D_TILE;
    const add = (instances, material) =>
      instances.length
        ? layerState._viewer.scene.groundPrimitives.add(
            new Cesium.GroundPolylinePrimitive({
              geometryInstances: instances,
              classificationType,
              appearance: new Cesium.PolylineMaterialAppearance({ material }),
            }),
          )
        : null;

    // Lines take the dots' active (preset-aware) colors.
    const dotColor = (bucket) =>
      layerState._activeBucketColors?.[bucket] || FLOW_BUCKET_COLORS[bucket];
    if (flowLines) {
      const lineColor = {
        jam: mono ? gray(1, FLOW_LINE_ALPHA) : dotColor('jam'),
        slow: mono ? gray(0.7, FLOW_LINE_ALPHA) : dotColor('slow'),
        free: mono ? gray(0.45, FLOW_LINE_ALPHA) : dotColor('free'),
      };
      for (const [bucket, key] of [
        ['free', '_heatFreePrim'],
        ['slow', '_heatSlowPrim'],
        ['jam', '_heatJamPrim'],
      ])
        layerState[key] = add(
          instancesFor(bucket, FLOW_LINE_WIDTH),
          Cesium.Material.fromType('Color', {
            color: lineColor[bucket].withAlpha(FLOW_LINE_ALPHA),
          }),
        );
    } else {
      const jamLineColor = mono ? Cesium.Color.WHITE : HEAT_JAM_COLOR;
      const slowLineColor = mono
        ? gray(0.7, HEAT_SLOW_COLOR.alpha)
        : HEAT_SLOW_COLOR;
      layerState._heatJamPrim = add(
        instancesFor('jam', HEAT_LINE_JAM_WIDTH),
        Cesium.Material.fromType('PolylineGlow', {
          color: jamLineColor.withAlpha(HEAT_JAM_BASE_ALPHA),
          glowPower: 0.25,
        }),
      );
      layerState._heatSlowPrim = add(
        instancesFor('slow', HEAT_LINE_SLOW_WIDTH),
        Cesium.Material.fromType('Color', { color: slowLineColor }),
      );
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
    if (layerState._viewer && filteredRoads.length) {
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
            Cesium.Cartesian3.distance(
              layerState._viewer.camera.positionWC,
              wp,
            ),
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
      services.credits?.showOsmCredit?.(layerState._viewer, 'traffic', {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
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
    retireHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
