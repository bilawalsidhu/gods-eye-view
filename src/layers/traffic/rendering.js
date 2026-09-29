import * as Cesium from 'cesium';
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
  MAX_DOTS,
} from './policy.js';

export function classifyExternalObservationFreshness(
  observedAt,
  staleAt,
  expiresAt,
  now = Date.now(),
) {
  const observed = Number(observedAt);
  const stale = Number(staleAt);
  const expires = Number(expiresAt);
  const current = Number(now);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    !Number.isFinite(current) ||
    current >= expires
  )
    return 'unavailable';
  if (Number.isFinite(stale) && current >= stale) return 'stale';
  return 'observed';
}

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  function observationLabel(contact, ageSec, freshness = 'observed') {
    const camera = String(
      contact.cameraCode || contact.cameraId || 'CCTV',
    ).toUpperCase();
    const type = String(contact.type || 'vehicle').toUpperCase();
    const confidence = Math.round(
      Math.max(0, Math.min(1, Number(contact.confidence) || 0)) * 100,
    );
    const freshnessLabel = freshness === 'stale' ? ' · STALE' : '';
    return `${camera} · ${type} · ${confidence}% · ${ageSec}s${freshnessLabel}`;
  }

  function stopExternalObservationTimerIfIdle() {
    if (
      layerState._externalVehicleObservations.size ||
      !layerState._externalObservationTimer
    )
      return;
    clearInterval(layerState._externalObservationTimer);
    layerState._externalObservationTimer = null;
  }

  function pruneExternalVehicleObservations() {
    const now = Date.now();
    let changed = false;
    for (const [sourceId, entries] of layerState._externalVehicleObservations) {
      const keep = [];
      for (const entry of entries) {
        if (entry.expiresAt <= now) {
          layerState._viewer?.entities?.remove(entry.entity);
          changed = true;
          continue;
        }
        const ageSec = Math.max(0, Math.floor((now - entry.observedAt) / 1000));
        const freshness = classifyExternalObservationFreshness(
          entry.observedAt,
          entry.staleAt,
          entry.expiresAt,
          now,
        );
        if (entry.entity?.label)
          entry.entity.label.text = observationLabel(entry.contact, ageSec, freshness);
        keep.push(entry);
      }
      if (keep.length)
        layerState._externalVehicleObservations.set(sourceId, keep);
      else layerState._externalVehicleObservations.delete(sourceId);
    }
    stopExternalObservationTimerIfIdle();
    if (changed) layerState._viewer?.scene?.requestRender?.();
  }

  /** Remove one producer's observations, or every producer when sourceId is null. */
  function clearExternalVehicleObservations(sourceId = null) {
    const sourceIds =
      sourceId === null
        ? [...layerState._externalVehicleObservations.keys()]
        : [String(sourceId)];
    let removed = 0;
    for (const id of sourceIds) {
      const entries = layerState._externalVehicleObservations.get(id) || [];
      for (const entry of entries) {
        if (layerState._viewer?.entities?.remove(entry.entity)) removed += 1;
      }
      layerState._externalVehicleObservations.delete(id);
    }
    stopExternalObservationTimerIfIdle();
    if (removed) layerState._viewer?.scene?.requestRender?.();
    return removed;
  }

  /**
   * Replace a producer's current ephemeral vehicle observations. No identity is
   * retained across calls: the prior frame's entities are destroyed first.
   */
  function replaceExternalVehicleObservations(
    sourceId,
    contacts,
    options = {},
  ) {
    const id = String(sourceId || '').trim();
    if (!id || !layerState._viewer || !layerState._enabled) return 0;
    clearExternalVehicleObservations(id);
    const ttlMs = Math.max(1000, Number(options.ttlMs) || 12000);
    const freshForMs = Math.max(
      0,
      Math.min(ttlMs, Number(options.freshForMs) || ttlMs),
    );
    const now = Date.now();
    const observationRevision = ++layerState._externalObservationRevision;
    const entries = [];
    for (const contact of Array.isArray(contacts) ? contacts : []) {
      if (!contact?.position) continue;
      const observedAt = Number.isFinite(Number(contact.observedAt))
        ? Number(contact.observedAt)
        : now;
      const entity = layerState._viewer.entities.add({
        id: `traffic-observed-${++layerState._externalObservationSequence}`,
        position: contact.position,
        properties: {
          gevSource: 'cctv-observed',
          sourceId: id,
          cameraId: contact.cameraId || null,
          confidence: Number(contact.confidence) || 0,
          observedAt,
          observationRevision,
          staleAt: observedAt + freshForMs,
          expiresAt: observedAt + ttlMs,
          authority: 'observation-only',
        },
        point: {
          pixelSize: 10,
          color: Cesium.Color.CYAN.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(100, 1.2, 15000, 0.55),
        },
        label: {
          text: observationLabel(contact, 0),
          font: '11px monospace',
          fillColor: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            5000,
          ),
        },
      });
      entries.push({
        entity,
        contact,
        observedAt,
        observationRevision,
        staleAt: observedAt + freshForMs,
        expiresAt: observedAt + ttlMs,
      });
    }
    if (entries.length) {
      layerState._externalVehicleObservations.set(id, entries);
      if (!layerState._externalObservationTimer) {
        layerState._externalObservationTimer = setInterval(
          pruneExternalVehicleObservations,
          1000,
        );
      }
      layerState._viewer.scene?.requestRender?.();
    }
    return entries.length;
  }

  function getExternalVehicleObservationCount() {
    let count = 0;
    for (const entries of layerState._externalVehicleObservations.values())
      count += entries.length;
    return count;
  }

  function getExternalVehicleDetectableObjects() {
    const result = [];
    const now = Date.now();
    for (const [sourceId, entries] of layerState._externalVehicleObservations) {
      for (const entry of entries) {
        const freshness = classifyExternalObservationFreshness(
          entry.observedAt,
          entry.staleAt,
          entry.expiresAt,
          now,
        );
        if (freshness === 'unavailable') continue;
        result.push({
          position: entry.contact.position,
          id: `CCTV-VEH-${entry.entity.id}`,
          type: 'VEH',
          sourceId,
          observed: true,
          freshness,
          observedAt: entry.observedAt,
          validUntil: entry.expiresAt,
          observationRevision: entry.observationRevision,
          authority: 'observation-only',
          provenance: {
            kind: 'cctv',
            sourceId,
            cameraId: entry.contact.cameraId || null,
          },
        });
      }
    }
    return result;
  }

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
                positions: c.road.waypoints,
                width,
              }),
            }),
        );

    // Mono presets (NVG/FLIR/noir) discard hue — heat-lines re-encode in
    // luminance like the dots: jam = white glow, slow = faint gray.
    const monoHeat =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const jamLineColor = monoHeat ? Cesium.Color.WHITE : HEAT_JAM_COLOR;
    const slowLineColor = monoHeat
      ? new Cesium.Color(0.7, 0.7, 0.7, HEAT_SLOW_COLOR.alpha)
      : HEAT_SLOW_COLOR;

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
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] Heat-lines capped at ${HEAT_LINE_CAP} (${candidates.length} congested roads in view)`,
      );
    }
  }

  /**
   * Clear existing dots and re-spawn them for the given road set and altitude.
   *
   * When zoomed out (>5 km), only major road types are rendered to reduce clutter.
   * Dot budgets are allocated fairly across visible roads via `allocateRoadDotBudgets`.
   *
   * @param {Array} roads    - Parsed road objects to render.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label    - Logging label (e.g. "Cache full", "Loaded major").
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   */

  function renderRoadsForAltitude(roads, altitude, label, trace = null) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingRenderState(trace, label)
        : null;
    const renderId = state ? ++trace.renderSequence : null;
    parts.animation.clearDots();
    layerState._roads = roads;
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
    const roadBudgets = parts.model.allocateRoadDotBudgets(
      filteredRoads,
      altitude,
      MAX_DOTS,
    );
    for (let i = 0; i < filteredRoads.length; i++) {
      const road = filteredRoads[i];
      const budget = roadBudgets[i] || 0;
      if (budget <= 0) continue;
      parts.animation.spawnDotsForRoad(road, altitude, budget);
      if (layerState._dots.length >= MAX_DOTS) break;
    }

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
    rebuildHeatLines(filteredRoads);
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

    layerState._count = layerState._dots.length;
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
    clearExternalVehicleObservations,
    replaceExternalVehicleObservations,
    getExternalVehicleObservationCount,
    getExternalVehicleDetectableObjects,
    visibleRoadsForAltitude,
    removeHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
