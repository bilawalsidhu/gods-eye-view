import * as Cesium from 'cesium';
import { gstime } from 'satellite.js';
import { reckonEarthFixed, sampleOrbit } from './motion.js';
import {
  ISS_NORAD,
  ORBIT_REBAKE_MS,
  ORBIT_RECKON_LIMIT_MS,
  ORBIT_SAMPLE_HORIZON_MS,
  POSITION_UPDATE_MS,
  RING_ROTATION_MS,
} from './policy.js';

/** Scratch for a point's reckoned position. */
const _reckoned = new Cesium.Cartesian3();

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    focusNowMs,
    getFocusTarget,
    focusPassIsNeeded,
    nearFarScalarValueAtDistance,
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
  } = services.focus;

  /**
   * Show orbital path for a satellite.
   *
   * RING FLICKER FIX: this is a one-instance Cesium.Primitive built
   * synchronously ONCE (asynchronous: false), then re-aligned to current GMST
   * each tick via its modelMatrix. The previous Entity-polyline approach
   * rebuilt geometry ASYNCHRONOUSLY on every positions assignment, which made
   * both the selected ring and the ISS ring blink once per second while the
   * rebuild was in flight. A rigid Z-rotation needs no rebuild at all.
   *
   * Why not a CallbackProperty entity (dynamic mode)? Verified in Cesium
   * 1.138 source: the dynamic polyline updater renders through a shared
   * PolylineCollection and applies only the fill material —
   * `depthFailMaterial` is silently dropped, losing the dimmed behind-Earth
   * segment. The Primitive keeps it via depthFailAppearance + the per-instance
   * depthFailColor attribute (same mechanism the entity STATIC batch uses):
   * bright where above the horizon, dimmed where behind the globe.
   */

  function _showOrbitPath(noradId, color) {
    if (layerState._orbitPaths.has(noradId)) return; // already showing

    const sat = layerState._catalog.get(noradId);
    if (!sat || !layerState._viewer) return;

    const bakeDate = new Date(layerState.now());
    const basePositions = parts.orbits.computeOrbitPath(sat.satrec, bakeDate);
    if (basePositions.length < 2) return;

    const pathColor = color || Cesium.Color.CYAN;
    // Kept so the Cockpit's orbit dim (cockpitSubject.js) restores exactly.
    const baseColor = pathColor.withAlpha(0.6);
    const baseDepthFailColor = pathColor.withAlpha(0.35);
    const instanceId = `satellite-orbit:${noradId}`;

    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        id: instanceId,
        geometry: new Cesium.PolylineGeometry({
          positions: basePositions,
          width: noradId === ISS_NORAD ? 2.5 : 2.0,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(baseColor),
          depthFailColor:
            Cesium.ColorGeometryInstanceAttribute.fromColor(baseDepthFailColor),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new Cesium.PolylineColorAppearance({
        translucent: true,
      }),
      asynchronous: false, // build this frame — no async-rebuild blink window
      allowPicking: false, // ring clicks fall through to satellites/deselect
    });
    layerState._viewer.scene.primitives.add(primitive);

    layerState._orbitPaths.set(noradId, {
      primitive,
      color: pathColor,
      bakeMs: bakeDate.getTime(),
      // Same Date object as computeOrbitPath's internal fixedGmst → identical
      // GMST value (gstime is pure), so delta starts at exactly 0 and the
      // initial identity modelMatrix is correct until the first ring tick.
      gmstAtBake: gstime(bakeDate),
      instanceId,
      baseColor,
      baseDepthFailColor,
      // The alpha multiple last written to the instance (1: as built).
      alphaFactor: 1,
    });
  }

  /**
   * Rotate every baked orbit ring from its bake-time ECEF snapshot to current
   * GMST (WS-D1). The baked ring is an inertial-frame snapshot frozen at
   * gmstAtBake; the live dot lives in true rotating-frame ECEF, so without this
   * the dot slides west off the ring at Earth-rotation rate (~0.25°/min).
   *
   * Sign derivation: a point fixed in inertial space keeps its right ascension
   * α, so its ECEF longitude λ = α − gmst DECREASES by ΔGMST as time advances
   * (it drifts WEST). Cesium.Matrix3.fromRotationZ(θ) rotates +X toward +Y,
   * i.e. INCREASES longitude by θ — so we rotate the baked points by −ΔGMST.
   * Mental check: ISS baked over Austin at t0; 10 min later Austin has rotated
   * east under the (inertial) ring, so the ring must sit further WEST in ECEF.
   *
   * Wraparound: gstime returns radians in [0, 2π), so the raw difference can be
   * off from the continuous ΔGMST — but only by exact multiples of 2π, which a
   * rotation cannot distinguish. Tiny negative deltas right after bake are
   * likewise harmless. No unwrapping needed.
   *
   * No SGP4 here — the rotation is applied as the ring primitive's modelMatrix
   * (exact compensation; WGS84 is rotationally symmetric about Z, so rotating
   * the baked curve rigidly equals rebaking from rotated points). modelMatrix
   * updates are synchronous uniforms — no geometry rebuild, no flicker. Post-
   * creation modelMatrix changes are supported for one-instance primitives in
   * 3D mode, which these rings are. In-place mutation is safe: Primitive.update
   * diffs modelMatrix against an internal clone.
   * @param {Date} nowDate Epoch used for current GMST.
   */

  function _updateOrbitPathRotations(nowDate) {
    if (layerState._orbitPaths.size === 0) return;

    for (const [noradId, path] of [...layerState._orbitPaths]) {
      if (!path.primitive) continue;
      // The rotation keeps the ring under the dot for minutes; the plane
      // itself precesses, so a world time moved far from the bake re-bakes.
      if (Math.abs(nowDate.getTime() - path.bakeMs) > ORBIT_REBAKE_MS) {
        _hideOrbitPath(noradId);
        _showOrbitPath(noradId, path.color);
        continue;
      }
      parts.orbits.orbitFrameModelMatrix(
        path.gmstAtBake,
        nowDate,
        path.primitive.modelMatrix,
      );
    }
  }

  /**
   * Remove orbital path for a satellite.
   */

  function _hideOrbitPath(noradId) {
    const path = layerState._orbitPaths.get(noradId);
    if (path) {
      if (layerState._viewer)
        layerState._viewer.scene.primitives.remove(path.primitive); // remove() destroys
      layerState._orbitPaths.delete(noradId);
    }
  }

  /**
   * Take a fresh SGP4 sample of every CORE satellite (motion.js); the points
   * move from these each frame in _reckonPoints. (About 1,300 core
   * satellites: ~840 measured at ≈ 1.6 ms/pass, so ≈ 2.5 ms, fine at the
   * 1s/200ms cadence.) Dense extras are excluded: they are sampled on the
   * round-robin budget in _propagateDenseChunk.
   * @returns {number} How many satellites were sampled.
   */

  function _propagateAll() {
    const nowMs = layerState.now();
    let updated = 0;

    for (const sat of layerState._catalog.values()) {
      if (sat.group === 'dense') continue;
      if (_sample(sat, nowMs)) updated++;
    }

    return updated;
  }

  /**
   * Sample one satellite's orbit at `atMs` into its reused sample.
   * @returns {boolean} Whether SGP4 had a state for that time.
   */

  function _sample(sat, atMs) {
    const sample = sampleOrbit(sat.satrec, atMs, sat.orbitSample);
    if (!sample) return false;
    sat.orbitSample = sample;
    return true;
  }

  /**
   * Move every shown point to where its satellite is at the world time,
   * reckoned from its last sample, so points glide every frame between
   * samples instead of stepping once a second. A core sample more than
   * ORBIT_SAMPLE_HORIZON_MS from the world time (time playing fast, or a
   * seek) is taken again first; dense extras are resampled by their own
   * round-robin. A hidden point is moved when it is shown again, and the
   * tracked satellite is placed by its per-frame path.
   * @param {number} nowMs World time, epoch ms.
   */

  function _reckonPoints(nowMs) {
    const gmst = gstime(new Date(nowMs));
    for (const [noradId, point] of layerState._points) {
      if (!point.show || noradId === layerState._trackedNorad) continue;
      const sat = layerState._catalog.get(noradId);
      if (!sat || sat.reckonedAtMs === nowMs) continue;
      let sample = sat.orbitSample;
      if (
        sat.group !== 'dense' &&
        (!sample || Math.abs(nowMs - sample[0]) > ORBIT_SAMPLE_HORIZON_MS)
      )
        sample = _sample(sat, nowMs) ? sat.orbitSample : null;
      if (!sample || Math.abs(nowMs - sample[0]) > ORBIT_RECKON_LIMIT_MS)
        continue;
      point.position = reckonEarthFixed(sample, nowMs, gmst, _reckoned); // setter clones
      sat.reckonedAtMs = nowMs;
    }
  }

  /**
   * Shared scene.preRender tick (single definition for init + enable):
   * - core fleet SGP4 samples at 200ms-tracked / 1s-idle cadence,
   * - dense extras sampled on a per-frame round-robin budget,
   * - every point reckoned from its sample each frame (motion.js),
   * - tracked satellite's point primitive per frame (WS-D2),
   * - orbit ring GMST re-alignment every ~1s (WS-D1).
   */

  function _preRenderTick() {
    if (!layerState._enabled) return;
    const now = focusNowMs(Date.now());

    const interval = layerState._trackedNorad ? 200 : POSITION_UPDATE_MS;
    // Space Missions keeps this layer enabled for TLE lookup while deliberately
    // hiding its standalone fleet. Do not rebuild hidden point buffers on the
    // one-second propagation cadence: that GPU upload presented as a periodic
    // whole-globe pulse even though the camera remained stationary.
    if (
      layerState._params.showPoints &&
      now - layerState._lastPropagation >= interval
    ) {
      _propagateAll();
      layerState._lastPropagation = now;
    }

    if (layerState._params.showPoints) {
      const worldMs = layerState.now();
      parts.catalog._propagateDenseChunk(worldMs - layerState._lastReckonMs);
      layerState._lastReckonMs = worldMs;
      _reckonPoints(worldMs);
    }

    // Keep the tracked dot on the per-frame epoch shared with label + camera —
    // runs after _propagateAll so the per-frame sample wins over the 200ms one.
    if (layerState._trackedNorad !== null) {
      const pos = parts.tracking._getTrackedFramePosition();
      const point = layerState._points.get(layerState._trackedNorad);
      if (pos && point) {
        point.position = layerState._trackedFrameCartesian; // primitive setter clones
      }
    }

    // While the Cockpit rides the tracked satellite, keep its marks hidden.
    if (layerState._cockpitSubjectNorad !== null)
      parts.cockpit?._syncCockpitSubjectVisuals();

    _updatePointFocus(now);

    // Hidden standalone orbit primitives do not need GMST matrix writes while
    // Space Missions draws the selected mission orbit itself.
    if (
      layerState._params.showOrbits &&
      now - layerState._lastRingRotation >= RING_ROTATION_MS
    ) {
      _updateOrbitPathRotations(new Date(layerState.now()));
      layerState._lastRingRotation = now;
    }
  }

  /** Focus alpha for satellite points, inside the existing shared preRender tick. */

  function _updatePointFocus(nowMs) {
    const target = getFocusTarget();
    if (
      !layerState._params.showPoints ||
      !focusPassIsNeeded(target, layerState._activeFocusCount)
    )
      return;
    if (nowMs - layerState._lastFocusUpdate < 80) return;
    layerState._lastFocusUpdate = nowMs;
    const scene = layerState._viewer.scene;
    const camera = layerState._viewer.camera;
    const result = applySatellitePointFocusDeemphasis({
      points: layerState._points,
      trackedId: layerState._trackedNorad,
      target,
      previousActiveCount: layerState._activeFocusCount,
      nowMs,
      screenPositionFor: (position) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          position,
          layerState._scratchFocusScreen,
        ),
      cameraDistanceFor: (position) =>
        Cesium.Cartesian3.distance(camera.positionWC, position),
      baseColorFor: (noradId) =>
        parts.controls._pointStyleFor(
          noradId,
          layerState._catalog.get(noradId)?.group,
        ).color,
    });
    layerState._activeFocusCount = result.activeCount;
  }

  /**
   * Apply the gated satellite-point focus pass through the production color path.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applySatellitePointFocusDeemphasis({
    points,
    trackedId,
    target,
    previousActiveCount = 0,
    nowMs,
    screenPositionFor,
    cameraDistanceFor,
    baseColorFor,
    params,
  }) {
    if (!focusPassIsNeeded(target, previousActiveCount)) {
      return { writes: 0, transitioning: false, activeCount: 0, ran: false };
    }
    let writes = 0;
    let transitioning = false;
    let activeCount = 0;
    for (const [noradId, point] of points || []) {
      if (noradId === trackedId || !point?.position) continue;
      const cameraDistance = cameraDistanceFor(point.position);
      const distanceScale = nearFarScalarValueAtDistance(
        point.scaleByDistance,
        cameraDistance,
      );
      const halfExtentPx = (point.pixelSize || 5) * distanceScale * 0.5;
      const focus = advanceSpriteFocus(point, {
        // Hidden points still release toward identity, preventing stale dim
        // alpha if a catalog/presentation toggle later makes them visible.
        screenPosition:
          point.show === false ? null : screenPositionFor(point.position),
        cameraDistance,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: halfExtentPx,
        spriteHalfHeightPx: halfExtentPx,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      const base = baseColorFor(noradId);
      const alpha = base.alpha * focus.factor;
      if (focusAlphaNeedsWrite(point.color?.alpha, alpha, params)) {
        // Point stays continuously present at the non-zero emphasis floor; its
        // own alpha yields around the tracked target, independent of draw order.
        point.color = base.withAlpha(alpha);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }
  return {
    _showOrbitPath,
    _updateOrbitPathRotations,
    _hideOrbitPath,
    _propagateAll,
    _reckonPoints,
    _preRenderTick,
    _updatePointFocus,
    applySatellitePointFocusDeemphasis,
  };
}
