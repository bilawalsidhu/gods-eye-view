import * as Cesium from 'cesium';
import { flowBucket } from '../../data/trafficFlowStyle.js';
import { trafficStyleProfile } from '../../data/trafficPresetStyle.js';
import {
  HEAT_LINE_CAP,
  HEAT_JAM_COLOR,
  HEAT_SLOW_COLOR,
  HEAT_LINE_JAM_WIDTH,
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_PULSE_ALPHA,
  HEAT_LINE_SLOW_WIDTH,
  TRAFFIC_TIMING_ENABLED,
} from './policy.js';

/**
 * Whether the surface the dots sit on has loaded what is in view: the
 * globe's tiles while it is shown, otherwise every shown 3D tileset (and
 * there is one). The globe port's settle states cannot say whether any
 * tileset is drawn at all, so this reads the scene.
 * @param {object|undefined} viewer
 */
export function surfaceTilesReady(viewer) {
  const scene = viewer?.scene;
  if (!scene) return false;
  if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
  let found = false;
  for (let i = 0; i < (scene.primitives?.length || 0); i++) {
    const primitive = scene.primitives.get(i);
    if (!primitive.show || typeof primitive.tilesLoaded !== 'boolean') continue;
    found = true;
    if (!primitive.tilesLoaded) return false;
  }
  return found;
}

// Stable ids for the objects heights are sampled from (tilesets, terrain).
const surfaceIds = new WeakMap();
let nextSurfaceId = 1;
const surfaceId = (object) => {
  if (!object || typeof object !== 'object') return 0;
  if (!surfaceIds.has(object)) surfaceIds.set(object, nextSurfaceId++);
  return surfaceIds.get(object);
};

/**
 * Name what heights are sampled against: the terrain provider when the globe
 * is shown, otherwise the set of visible 3D tilesets. A map-provider switch
 * changes it and invalidates every cached height. The renderer contract
 * names no surface identity, so this reads the scene.
 * @param {object|undefined} viewer
 */
const surfaceKeys = new WeakMap();
export function trafficSurfaceKey(viewer) {
  const scene = viewer?.scene;
  if (!scene) return '';
  let state = surfaceKeys.get(scene);
  if (!state) {
    state = { globe: null, terrain: null, tiles: [], key: '' };
    surfaceKeys.set(scene, state);
  }
  const globe = Boolean(scene.globe?.show);
  const terrain = globe ? scene.globe.terrainProvider : null;
  let changed = state.globe !== globe || state.terrain !== terrain;
  let count = 0;
  if (!globe) {
    for (let i = 0; i < (scene.primitives?.length || 0); i++) {
      const primitive = scene.primitives.get(i);
      if (!primitive?.show || typeof primitive.tilesLoaded !== 'boolean')
        continue;
      if (state.tiles[count] !== primitive) {
        state.tiles[count] = primitive;
        changed = true;
      }
      count++;
    }
  }
  if (count !== state.tiles.length) {
    state.tiles.length = count;
    changed = true;
  }
  if (changed) {
    state.globe = globe;
    state.terrain = terrain;
    // Allocate only when the actual map surface changes, never per frame.
    state.key = globe
      ? `globe:${surfaceId(terrain)}`
      : `tiles:${state.tiles.map(surfaceId).join(',')}`;
  }
  return state.key;
}

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

  /** Remove both heat-line ground primitives from the scene. */

  function removeHeatLines() {
    if (layerState._heatJamPrim) {
      layerState._viewer?.scene.groundPrimitives.remove(
        layerState._heatJamPrim,
      );
      layerState._heatJamPrim = null;
    }
    if (layerState._heatSlowPrim) {
      layerState._viewer?.scene.groundPrimitives.remove(
        layerState._heatSlowPrim,
      );
      layerState._heatSlowPrim = null;
    }
    layerState._heatLineCount = 0;
    parts.animation.syncRenderDemand?.();
  }

  /**
   * Rebuild the congestion heat-line underlay (jam-viz heatline prototype):
   * slow/jam roads drape a corridor line onto the rendered 3D tiles — glowing
   * pulsing red for jam, faint flat amber for slow — with the dots animating
   * on top. Two batched GroundPolylinePrimitives (one per bucket) so the jam
   * batch pulses through one shared material. Capped at HEAT_LINE_CAP (jam
   * first, longest first); overflow is logged. No-op in sim mode, when the
   * heatline mode is off, or without ground-primitive support.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildHeatLines(roads) {
    removeHeatLines();
    if (
      !layerState._viewer ||
      !layerState._liveMode ||
      !parts.style.heatlineOn()
    )
      return;
    if (layerState._heatSupported === null) {
      layerState._heatSupported = Cesium.GroundPolylinePrimitive.isSupported(
        layerState._viewer.scene,
      );
      if (!layerState._heatSupported)
        console.warn(
          '[Data:Traffic] GroundPolylinePrimitive unsupported — heat-lines disabled',
        );
    }
    if (!layerState._heatSupported) return;

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

    const instancesFor = (bucket, width) =>
      kept
        .filter((c) => c.bucket === bucket)
        .map(
          (c) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                // A snapshot of the waypoints, as the renderer's points.
                positions: c.road.waypoints.map((p) =>
                  Cesium.Cartesian3.clone(p),
                ),
                width,
              }),
            }),
        );

    // Mono presets (NVG/FLIR/noir) discard hue — heat-lines re-encode in
    // luminance like the dots: jam = white glow, slow = faint gray.
    const monoHeat =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const jamLineColor = monoHeat
      ? Cesium.Color.WHITE
      : new Cesium.Color(...HEAT_JAM_COLOR);
    const slowLineColor = monoHeat
      ? new Cesium.Color(0.7, 0.7, 0.7, HEAT_SLOW_COLOR[3])
      : new Cesium.Color(...HEAT_SLOW_COLOR);

    const jamInstances = instancesFor('jam', HEAT_LINE_JAM_WIDTH);
    if (jamInstances.length) {
      layerState._heatJamPrim = layerState._viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: jamInstances,
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('PolylineGlow', {
              color: jamLineColor.withAlpha(HEAT_JAM_BASE_ALPHA),
              glowPower: 0.25,
            }),
          }),
        }),
      );
    }
    const slowInstances = instancesFor('slow', HEAT_LINE_SLOW_WIDTH);
    if (slowInstances.length) {
      layerState._heatSlowPrim = layerState._viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: slowInstances,
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          appearance: new Cesium.PolylineMaterialAppearance({
            material: Cesium.Material.fromType('Color', {
              color: slowLineColor,
            }),
          }),
        }),
      );
    }

    layerState._heatLineCount = kept.length;
    parts.animation.syncRenderDemand?.();
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] Heat-lines capped at ${HEAT_LINE_CAP} (${candidates.length} congested roads in view)`,
      );
    }
  }

  /** Whether jam heat-lines are drawn, which pulse every frame. */
  const heatPulsing = () => Boolean(layerState._heatJamPrim);

  /**
   * Throb the jam heat-lines (~1.6 s period): one shared material uniform
   * for the whole jam batch, no geometry rebuild.
   * @param {number} now - Epoch ms.
   */
  function pulseHeatLines(now) {
    if (layerState._heatJamPrim?.appearance) {
      layerState._heatJamPrim.appearance.material.uniforms.color.alpha =
        HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA * Math.sin(now / 260);
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
    heatPulsing,
    pulseHeatLines,
    visibleRoadsForAltitude,
    removeHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
