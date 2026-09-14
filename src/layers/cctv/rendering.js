import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import {
  ACTIVE_CAMERA_COLOR,
  IDLE_CAMERA_COLOR,
  ACTIVE_COVERAGE_CENTER,
  IDLE_COVERAGE_CENTER_MUTED,
  ACTIVE_COVERAGE_CENTER_DEPTHFAIL,
  ACTIVE_COVERAGE_EDGE,
  IDLE_COVERAGE_EDGE_MUTED,
  ACTIVE_COVERAGE_EDGE_DEPTHFAIL,
} from './policy.js';

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
    advanceSpriteFocus,
    focusAlphaNeedsWrite,
  } = services.focus;

  /**
   * Focus modulation rides the layer's existing animation loop; no additional
   * scene listener is installed. Only camera-icon alpha changes here — coverage
   * geometry and monitor-plane styling retain their established cadence.
   */

  function refreshCctvFocusStyles(nowMs) {
    nowMs = focusNowMs(nowMs);
    const target = getFocusTarget();
    if (
      !layerState._enabled ||
      !layerState._viewer ||
      !focusPassIsNeeded(target, layerState._activeFocusStyleCount)
    )
      return;
    if (nowMs - layerState._lastFocusStyleAt < 80) return;
    layerState._lastFocusStyleAt = nowMs;
    const scene = layerState._viewer.scene;
    const camera = layerState._viewer.camera;
    const result = applyCctvFocusDeemphasis({
      records: layerState._records,
      target,
      previousActiveCount: layerState._activeFocusStyleCount,
      nowMs,
      screenPositionFor: (position) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          position,
          layerState._scratchFocusScreen,
        ),
      cameraDistanceFor: (position) =>
        Cesium.Cartesian3.distance(camera.positionWC, position),
      baseColorFor: (record) =>
        record.camera.id === layerState._activeCameraId
          ? ACTIVE_CAMERA_COLOR
          : IDLE_CAMERA_COLOR,
    });
    layerState._activeFocusStyleCount = result.activeCount;
  }

  /**
   * Apply the gated CCTV focus pass through the production color path.
   * @param {object} input
   * @returns {{writes:number,transitioning:boolean,activeCount:number,ran:boolean}}
   */

  function applyCctvFocusDeemphasis({
    records,
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
    for (const record of records || []) {
      const bb = record.billboard;
      if (!bb) continue;
      const position = bb.position;
      // CCTV never publishes a tracked focus target, so every icon is ambient.
      const focus = advanceSpriteFocus(bb, {
        // Keep hidden icons in the state/release pass so the active count cannot
        // drop while a stale dim alpha remains waiting to reappear.
        screenPosition:
          bb.show === false || !position ? null : screenPositionFor(position),
        cameraDistance: position ? cameraDistanceFor(position) : Number.NaN,
        nowMs,
        target,
        params,
        spriteHalfWidthPx: (bb.width || 24) * (bb.scale || 1) * 0.5,
        spriteHalfHeightPx: (bb.height || 24) * (bb.scale || 1) * 0.5,
      });
      transitioning ||= focus.transitioning;
      if (focus.active) activeCount += 1;
      const base = baseColorFor(record);
      const alpha = base.alpha * focus.factor;
      if (focusAlphaNeedsWrite(bb.color?.alpha, alpha, params)) {
        // Order-independent narrow amendment to always-visible icons: CCTV
        // contacts retain a non-zero floor while yielding near the tracked target.
        bb.color = base.withAlpha(alpha);
        writes += 1;
      }
    }
    return { writes, transitioning, activeCount, ran: true };
  }

  /**
   * Updates visual styles (colors, widths, visibility) for all camera billboards,
   * coverage polylines, viewshed volumes, and projection entities based on which
   * camera is active, whether the layer is enabled, and the current
   * coverage-mode/projection toggle states.
   */
  /**
   * Field-test fix (2026-07-06): horizon-culls camera billboards, mirroring the
   * flights layer's EllipsoidalOccluder pass. With the Cesium globe hidden
   * (Google-3D regime) nothing writes far-side depth, and the billboards are now
   * always-on-top (`disableDepthTestDistance: INFINITY` — the far-zoom submerge
   * fix), so without this pass London's cluster would shine through the planet
   * from a US viewpoint. Pure math over ≤ catalog-size points; runs on
   * camera.moveEnd + init only (event-driven — no steady-state work).
   */

  function refreshHorizonCulling() {
    if (
      !layerState._viewer ||
      layerState._viewer.isDestroyed() ||
      !layerState._records.length
    )
      return;
    const occluder = horizonOccluder(layerState._viewer.camera);
    for (const record of layerState._records) {
      const bb = record.billboard;
      if (!bb) continue;
      const visible = occluder.isPointVisible(bb.position);
      if (bb.show !== visible) bb.show = visible;
    }
  }

  /**
   * Hides every per-record CCTV visual without recomputing coverage membership or
   * styles. Disabling makes every visibility branch false, so a direct sweep is
   * sufficient; live viewshed primitives still require explicit destruction.
   *
   * @param {Object[]} records CCTV runtime records.
   * @param {(record: Object) => void} destroyVolume Viewshed teardown callback.
   * @param {string|null} [activeCameraId=null] Active camera whose activation probe must be re-armed.
   */

  function hideCctvRecordVisuals(
    records,
    destroyVolume,
    activeCameraId = null,
  ) {
    for (const record of Array.isArray(records) ? records : []) {
      if (record) {
        record.probeClampRangeM = null;
        if (record.camera?.id === activeCameraId) record.activationDone = false;
      }
      for (const entity of record?.coverageEntities || []) entity.show = false;
      if (record?.viewshedPrimitive) destroyVolume?.(record);
      if (record?.projection?.planeEntity)
        record.projection.planeEntity.show = false;
    }
  }

  function hideCctvVisuals() {
    hideCctvRecordVisuals(
      layerState._records,
      parts.geometry.destroyViewshedVolume,
      layerState._activeCameraId,
    );
    parts.projection.clearProjectionOverlay();
    if (layerState._billboards) layerState._billboards.show = false;
    parts.projection.pauseInactiveProjectionFeeds(null);
  }

  /** Applies coverage visibility/style state and lazily builds eligible sets. */

  function refreshCoverageStyles() {
    const activeRecord = parts.selection.getActiveRecord();
    parts.geometry.ensureActiveCoverageEntities(activeRecord);
    const activeId = activeRecord?.camera.id || null;
    const coverageVisible =
      parts.geometry.buildCoverageVisibleSet(activeRecord);
    const coverageOn = layerState._coverageMode !== 'off';
    const viewshedOn = layerState._coverageMode === 'viewshed';
    if (coverageOn) {
      parts.geometry.ensureVisibleCoverageEntities(
        layerState._records,
        coverageVisible,
      );
    }
    for (const record of layerState._records) {
      const isActive = record.camera.id === activeId;
      if (record.billboard) {
        record.billboard.color = isActive
          ? ACTIVE_CAMERA_COLOR
          : IDLE_CAMERA_COLOR;
        record.billboard.scale = isActive ? 1.25 : 1.0;
        // disableDepthTestDistance stays POSITIVE_INFINITY for every billboard
        // (set at creation) — see the field-test far-zoom submerge fix there.
      }

      if (layerState._enabled && layerState._showProjection && isActive) {
        parts.projection.ensureProjectionRuntime(record);
      }
      // One live plane in the world at a time (§2c): only the active camera's
      // far cap carries the monitor plane; idle neighbors get the faint
      // wireframe only.
      const planeShowing = !!(
        layerState._enabled &&
        layerState._showProjection &&
        isActive
      );

      const inVisibleSet = coverageVisible.has(record.camera.id);
      for (const entity of record.coverageEntities || []) {
        // The frustum wireframe is part of the projection representation —
        // force it on for the active camera and let it read through geometry
        // via depthFailMaterial (polylines have no disableDepthTestDistance).
        entity.show = !!(
          layerState._enabled &&
          ((coverageOn && inVisibleSet) || planeShowing)
        );
        if (!entity.polyline) continue;
        // Viewshed mode swaps the cyan/green scheme for the camera's own hue so
        // adjacent cones read as distinct coverage claims (design §3b); the
        // active camera keeps its width/alpha emphasis in both schemes.
        const hue = viewshedOn ? record.viewshedColors : null;
        if (entity._coverageRole === 'cap') {
          entity.polyline.material = hue
            ? isActive
              ? hue.lineActive
              : hue.line
            : isActive
              ? ACTIVE_COVERAGE_CENTER
              : IDLE_COVERAGE_CENTER_MUTED;
          entity.polyline.width = isActive ? 2.2 : 1.0;
          entity.polyline.depthFailMaterial = planeShowing
            ? hue
              ? hue.line.withAlpha(0.26)
              : ACTIVE_COVERAGE_CENTER_DEPTHFAIL
            : undefined;
        } else {
          entity.polyline.material = hue
            ? isActive
              ? hue.lineActive
              : hue.line.withAlpha(0.6)
            : isActive
              ? ACTIVE_COVERAGE_EDGE
              : IDLE_COVERAGE_EDGE_MUTED;
          entity.polyline.width = isActive ? 1.8 : 0.9;
          entity.polyline.depthFailMaterial = planeShowing
            ? hue
              ? hue.line.withAlpha(0.18)
              : ACTIVE_COVERAGE_EDGE_DEPTHFAIL
            : undefined;
        }
      }

      // Viewshed volume lifecycle: exists iff enabled + viewshed mode + in the
      // visible set. Rebuild on active-tint flips (rare); otherwise leave the
      // primitive alone so idle refreshes never churn geometry.
      const wantVolume = !!(
        layerState._enabled &&
        viewshedOn &&
        inVisibleSet &&
        record.frustumPositions
      );
      if (wantVolume) {
        if (
          !record.viewshedPrimitive ||
          record.viewshedActiveTint !== isActive
        ) {
          parts.geometry.rebuildViewshedVolume(record, isActive);
        }
      } else if (record.viewshedPrimitive) {
        parts.geometry.destroyViewshedVolume(record);
      }

      if (record.projection) {
        parts.projection.setPlaneVisible(record.projection, planeShowing);
      }
    }

    if (layerState._billboards)
      layerState._billboards.show = !!layerState._enabled;
    parts.projection.pauseInactiveProjectionFeeds(activeId);
  }
  return {
    refreshCctvFocusStyles,
    applyCctvFocusDeemphasis,
    refreshHorizonCulling,
    hideCctvRecordVisuals,
    hideCctvVisuals,
    refreshCoverageStyles,
  };
}
