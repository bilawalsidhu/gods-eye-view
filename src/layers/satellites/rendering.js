import * as Cesium from 'cesium';
// The camera and frame ports over a viewer with no renderer bound, for the
// tracking and lifecycle parts that follow and tick through them.
import '../../render/cesium/camera.js';
import '../../render/cesium/frame.js';
import { toCartesian } from '../../render/cesium/common.js';
import { toColor as cesiumColor } from '../../render/cesium/draw.js';
import { gstime } from 'satellite.js';
import { ISS_NORAD, POSITION_UPDATE_MS, RING_ROTATION_MS } from './policy.js';

/**
 * The satellites layer's Cesium side: the point collection and its point
 * primitives, the baked orbit-ring primitives, the tracked entity the follow
 * camera and the tracked card read, and the per-frame tick that moves them.
 * The other parts hand it render-contract values (ECEF `{x, y, z}`, colours
 * as `[r, g, b, a]`) and never touch these objects themselves.
 */

/** Points shrink with distance as they always have. */
const POINT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(1e6, 1.5, 2e7, 0.6);

/** Each policy style once in Cesium's colours (styles are module constants). */
const cesiumStyles = new WeakMap();
function cesiumStyleOf(style) {
  let converted = cesiumStyles.get(style);
  if (!converted) {
    converted = {
      pixelSize: style.pixelSize,
      color: cesiumColor(style.color),
      outlineColor: cesiumColor(style.outlineColor),
      outlineWidth: style.outlineWidth,
    };
    cesiumStyles.set(style, converted);
  }
  return converted;
}

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
    publishFocusTargetAt,
  } = services.focus;

  const scratchFocusScreen = new Cesium.Cartesian2();
  const scratchRingRotation = new Cesium.Matrix3();
  // The tracked satellite's per-frame ECEF sample (WS-D2), shared with the
  // tracked entity, the follow camera and the tracked card. Tracking writes
  // its x/y/z; it stays one Cesium value for the readers that take it.
  layerState._trackedFrameCartesian = new Cesium.Cartesian3();

  /**
   * Build the rigid ECEF transform that keeps an orbit path baked at one GMST
   * aligned with live SGP4 positions propagated at another epoch.
   * @param {number} gmstAtBake GMST used when the path positions were baked.
   * @param {Date} nowDate Epoch whose rotating-Earth frame should be displayed.
   * @param {Cesium.Matrix4} [result] Optional matrix to update in place.
   * @returns {Cesium.Matrix4} Z-rotation from bake-time ECEF to current ECEF.
   */

  function orbitFrameModelMatrix(
    gmstAtBake,
    nowDate,
    result = new Cesium.Matrix4(),
  ) {
    const deltaGmst = gstime(nowDate) - gmstAtBake;
    const rotation = Cesium.Matrix3.fromRotationZ(
      -deltaGmst,
      scratchRingRotation,
    );
    return Cesium.Matrix4.fromRotationTranslation(
      rotation,
      Cesium.Cartesian3.ZERO,
      result,
    );
  }

  /** ECEF `{x, y, z}` positions as the renderer's own. */
  function _rendererPositions(positions) {
    return positions.map(toCartesian);
  }

  /** The scene's rendered-frame number, the tracked sample's cache key. */
  function _drawnFrameNumber() {
    return layerState._viewer?.scene?.frameState?.frameNumber ?? -1;
  }

  /** Add the point collection the satellite dots draw in. */
  function _attach(viewer) {
    layerState._pointCollection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(layerState._pointCollection);
  }

  /** Remove the point collection and every orbit ring from `viewer`. */
  function _detach(viewer) {
    if (layerState._pointCollection) {
      viewer.scene.primitives.remove(layerState._pointCollection);
      layerState._pointCollection = null;
    }
    // Orbit ring primitives are removed (and destroyed) here
    for (const path of layerState._orbitPaths.values()) {
      viewer.scene.primitives.remove(path.primitive);
    }
  }

  /** Whether there is a point collection to draw satellites in. */
  function _hasPointCollection() {
    return Boolean(layerState._pointCollection);
  }

  /** Whether the satellite dots are shown. */
  function _pointsShown() {
    return Boolean(layerState._pointCollection?.show);
  }

  function _setPointsShown(show) {
    if (layerState._pointCollection) layerState._pointCollection.show = show;
  }

  function _setOrbitPathsShown(show) {
    for (const path of layerState._orbitPaths.values())
      path.primitive.show = show;
  }

  function _setOrbitPathShown(noradId, show) {
    const path = layerState._orbitPaths.get(noradId);
    if (path) path.primitive.show = show;
  }

  /** Remove every orbit ring from `viewer`'s scene. */
  function _clearOrbitPaths(viewer) {
    for (const path of layerState._orbitPaths.values())
      viewer.scene.primitives.remove(path.primitive);
    layerState._orbitPaths.clear();
  }

  /**
   * Draw one satellite's dot.
   * @param {number} noradId
   * @param {{x: number, y: number, z: number}} position ECEF metres.
   * @param {object} style A `POINT_STYLES` entry.
   */
  function _addPoint(noradId, position, style) {
    const look = cesiumStyleOf(style);
    const point = layerState._pointCollection.add({
      position: toCartesian(position),
      pixelSize: look.pixelSize,
      color: look.color,
      outlineColor: look.outlineColor,
      outlineWidth: look.outlineWidth,
      scaleByDistance: POINT_SCALE_BY_DISTANCE,
      id: noradId,
    });
    layerState._points.set(noradId, point);
  }

  /** Move a drawn dot to ECEF `position`; false when it has none. */
  function _movePoint(noradId, position) {
    const point = layerState._points.get(noradId);
    if (!point) return false;
    point.position = position; // primitive setter clones
    return true;
  }

  function _removePoint(noradId) {
    const point = layerState._points.get(noradId);
    if (point && layerState._pointCollection)
      layerState._pointCollection.remove(point);
    layerState._points.delete(noradId);
  }

  /** Remove every dot. */
  function _clearPoints() {
    layerState._pointCollection.removeAll();
    layerState._points.clear();
  }

  /** Where a dot is drawn (ECEF), or null. */
  function _pointPosition(noradId) {
    return layerState._points.get(noradId)?.position || null;
  }

  /** Hide a dot while the tracked entity draws it. */
  function _hidePoint(noradId) {
    const point = layerState._points.get(noradId);
    if (point) point.show = false;
  }

  /** Show a dot again in its group's style (WS-D3). */
  function _restorePoint(noradId, style) {
    const point = layerState._points.get(noradId);
    if (!point) return;
    const look = cesiumStyleOf(style);
    point.show = true;
    point.pixelSize = look.pixelSize;
    point.color = look.color;
    point.outlineColor = look.outlineColor;
    point.outlineWidth = look.outlineWidth;
    point.disableDepthTestDistance = 0;
  }

  /**
   * Add the tracked satellite's entity: it owns a point graphic so the
   * follow camera can resolve a bounding sphere (a label-only entity left
   * the camera stranded), and the tracked card reads its entity record.
   * @param {{position: () => object, viewFrom: {x: number, y: number,
   *   z: number}}} options `position` is evaluated every time it is read.
   * @returns {object} The entity.
   */
  function _addTrackedEntity({ position, viewFrom }) {
    return layerState._viewer.entities.add({
      position: new Cesium.CallbackProperty(position, false),
      viewFrom: toCartesian(viewFrom),
      point: {
        pixelSize: 14,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function _removeTrackedEntity(entity) {
    layerState._viewer.entities.remove(entity);
  }

  /** Whether a scene pick is the tracked satellite's entity. */
  function _pickIsTrackedEntity(picked) {
    return picked?.id === layerState._trackedEntity;
  }

  /**
   * The NORAD id a scene pick's point primitive carries, or null. Any
   * primitive with a numeric id answers; the caller checks the catalog.
   */
  function _pickedPointId(picked) {
    const prim = picked?.primitive;
    if (!prim || prim.id == null) return null;
    const noradId = Number(prim.id);
    return isNaN(noradId) ? null : noradId;
  }

  /** Publish the tracked satellite's focus rectangle from its cached position. */
  function _publishTrackedFocus(target) {
    publishFocusTargetAt({ ...target, viewer: layerState._viewer });
  }

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

    const bakeDate = new Date();
    const basePositions = _rendererPositions(
      parts.orbits.computeOrbitPath(sat.satrec, bakeDate),
    );
    if (basePositions.length < 2) return;

    const pathColor = color ? cesiumColor(color) : Cesium.Color.CYAN;

    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: basePositions,
          width: noradId === ISS_NORAD ? 2.5 : 2.0,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.6),
          ),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.35),
          ),
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
      // Same Date object as computeOrbitPath's internal fixedGmst → identical
      // GMST value (gstime is pure), so delta starts at exactly 0 and the
      // initial identity modelMatrix is correct until the first ring tick.
      gmstAtBake: gstime(bakeDate),
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

    for (const path of layerState._orbitPaths.values()) {
      if (!path.primitive) continue;
      orbitFrameModelMatrix(
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
   * Propagate all CORE satellite positions and update point primitives.
   * (~840 sats ≈ 1.6 ms/pass — fine at the 1s/200ms cadence.) Dense extras are
   * excluded: they refresh on the round-robin budget in _propagateDenseChunk.
   */

  function _propagateAll() {
    const now = new Date();
    let updated = 0;

    for (const [noradId, sat] of layerState._catalog) {
      if (sat.group === 'dense') continue;
      const pos = parts.orbits.propagatePosition(sat.satrec, now);
      if (!pos) continue;

      const cartesian = Cesium.Cartesian3.fromDegrees(
        pos.longitude,
        pos.latitude,
        pos.altitude,
      );
      const point = layerState._points.get(noradId);
      if (point) {
        point.position = cartesian;
        updated++;
      }
    }

    return updated;
  }

  /**
   * Shared scene.preRender tick (single definition for init + enable):
   * - core fleet propagation at 200ms-tracked / 1s-idle cadence,
   * - dense extras on a per-frame round-robin budget,
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

    if (layerState._params.showPoints) parts.catalog._propagateDenseChunk();

    // Keep the tracked dot on the per-frame epoch shared with label + camera —
    // runs after _propagateAll so the per-frame sample wins over the 200ms one.
    if (layerState._trackedNorad !== null) {
      const pos = parts.tracking._getTrackedFramePosition();
      const point = layerState._points.get(layerState._trackedNorad);
      if (pos && point) {
        point.position = layerState._trackedFrameCartesian; // primitive setter clones
      }
    }

    _updatePointFocus(now);

    // Hidden standalone orbit primitives do not need GMST matrix writes while
    // Space Missions draws the selected mission orbit itself.
    if (
      layerState._params.showOrbits &&
      now - layerState._lastRingRotation >= RING_ROTATION_MS
    ) {
      _updateOrbitPathRotations(new Date(now));
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
          scratchFocusScreen,
        ),
      cameraDistanceFor: (position) =>
        Cesium.Cartesian3.distance(camera.positionWC, position),
      baseColorFor: (noradId) =>
        cesiumStyleOf(
          parts.controls._pointStyleFor(
            noradId,
            layerState._catalog.get(noradId)?.group,
          ),
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
    orbitFrameModelMatrix,
    _rendererPositions,
    _drawnFrameNumber,
    _attach,
    _detach,
    _hasPointCollection,
    _pointsShown,
    _setPointsShown,
    _setOrbitPathsShown,
    _setOrbitPathShown,
    _clearOrbitPaths,
    _addPoint,
    _movePoint,
    _removePoint,
    _clearPoints,
    _pointPosition,
    _hidePoint,
    _restorePoint,
    _addTrackedEntity,
    _removeTrackedEntity,
    _publishTrackedFocus,
    _pickIsTrackedEntity,
    _pickedPointId,
    _showOrbitPath,
    _updateOrbitPathRotations,
    _hideOrbitPath,
    _propagateAll,
    _preRenderTick,
    _updatePointFocus,
    applySatellitePointFocusDeemphasis,
  };
}
