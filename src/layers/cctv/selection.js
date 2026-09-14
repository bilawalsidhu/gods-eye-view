import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from '../../data/trackingClickGesture.js';
import * as Cesium from 'cesium';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { CCTV_ACTIVATION_RESULT } = services.activation;
  const { resolvePickId } = services.picking;

  /**
   * Returns the camera record for the currently active camera. A stale ID falls
   * back to the first record, but an intentional null remains an honest
   * deselected state.
   * @returns {Object|null} Active camera record, or null when none is active.
   */

  function getActiveRecord() {
    if (!layerState._activeCameraId) return null;
    if (layerState._recordById.has(layerState._activeCameraId)) {
      return layerState._recordById.get(layerState._activeCameraId);
    }
    // Sync _activeCameraId when falling back to first record to prevent ID mismatch
    const fallback = layerState._records[0] || null;
    if (fallback && fallback.camera?.id) {
      layerState._activeCameraId = fallback.camera.id;
    }
    return fallback;
  }

  /**
   * Bind CCTV activation to clean taps while preserving the layer's hover-move
   * callback on the shared Cesium handler. Drag-like and long-press gestures do
   * not reach camera activation or focus dispatch.
   * @param {Cesium.ScreenSpaceEventHandler|Object} handler - Input handler.
   * @param {(click: Object) => void} onClick - Accepted CCTV click callback.
   * @param {Object} [options] - Gesture test seams and optional onMouseMove hook.
   * @returns {void}
   */

  function bindCctvWorldClickGesture(handler, onClick, options = {}) {
    bindTrackingClickGesture(
      handler,
      (click, gesture) => {
        if (!isTrackingClickGesture(gesture)) return;
        onClick(click);
      },
      options,
    );
  }

  /**
   * Sets the active camera by ID, initializes its projection runtime, refreshes
   * its frame, and updates styles.
   * @param {string} cameraId - ID of the camera to activate.
   * @returns {'activated'|'unchanged'|'not-found'} Discriminated activation result.
   */

  function setActiveCamera(cameraId) {
    if (!cameraId || !layerState._recordById.has(cameraId))
      return CCTV_ACTIVATION_RESULT.NOT_FOUND;
    const record = layerState._recordById.get(cameraId);
    const previousActiveRecord = getActiveRecord();
    // Re-selecting the already-active camera is a no-op: re-running the
    // activation path re-probes and rewrites the plane entity's geometry, and
    // that async primitive rebuild visibly flashes the monitor plane (owner
    // field test 2026-07-04 — every click ON the plane picks its own camera).
    // `activationDone` distinguishes a real activation from the enable()-time
    // default `_activeCameraId` assignment, which never ran this path.
    if (
      !parts.model.cctvRecordNeedsActivation(
        cameraId,
        layerState._activeCameraId,
        record,
      )
    ) {
      return CCTV_ACTIVATION_RESULT.UNCHANGED;
    }
    layerState._activeCameraId = cameraId;
    layerState._autoHopSuspended = false;
    // A real activation creates projection work — wake the self-stopping loop.
    parts.projection.startProjectionLoop();
    if (previousActiveRecord && previousActiveRecord !== record) {
      parts.geometry.clearProbeClampOnDeactivation(
        previousActiveRecord,
        (previous) => {
          parts.geometry.applyFrustumGeometry(
            previous,
            parts.ground.groundAltFor(previous),
          );
        },
      );
    }
    // The clicked camera leaves the ambient quota immediately (never graced).
    // Shipped behavior publishes no card for it because the monitor plane is
    // now the active representation; the opt-in protected-card path republishes
    // it synchronously through refreshAmbientCards() below.
    layerState._cardIds.delete(cameraId);
    layerState._cardGraceState.delete(cameraId);
    // Activating the hovered camera consumes the transient pin; the active
    // monitor plane replaces it from this moment.
    if (layerState._hoverCardId === cameraId) parts.hover.clearHoverCard();
    // If the record's geometry refinement is still queued, jump it to the front
    // so the newly active camera resolves before idle neighbors.
    const queueIdx = layerState._geoQueue.indexOf(record);
    if (queueIdx > 0) {
      layerState._geoQueue.splice(queueIdx, 1);
      layerState._geoQueue.unshift(record);
    }
    // §9.1: one obstruction probe per activation, BEFORE the geometry pass so
    // the range clamp lands in the same rewrite. A FIRST-EVER activation (no
    // real ground sample yet) probes from the catalog-prior altitude — if that
    // prior is off, the clamp is measured from a shifted origin, but a
    // re-activation after the one-shot snap lands re-probes from real ground,
    // so it self-corrects.
    parts.geometry.runActivationObstructionProbe(record);
    // Coverage is activation-lazy even while the mode is OFF: the active
    // camera's projection representation must be ready without materializing
    // any idle neighbor. The following geometry rewrite welds these entities to
    // the current sampled positions.
    parts.geometry.ensureActiveCoverageEntities(record);
    parts.projection.ensureProjectionRuntime(record);
    parts.frames.refreshProjectionImage(record, true);
    // FIX B9b: an explicit user (re)select re-arms one real ground sample for the
    // newly-active camera, then freezes. Idle neighbors keep their resolved state.
    // FIX B9c: if tiles are ready this real pass applies + re-resolves
    // immediately; if tiles are still streaming, updateRecordGeometry's fallback
    // guard recomputes purely from the cached real ground (the pose + the probe
    // clamp above still land — no scene queries) and the record stays unresolved
    // until update()'s one-shot tiles-ready completion pass re-grounds it.
    parts.ground.rearmGroundResolution(record);
    parts.geometry.updateRecordGeometry(record);
    // Ground under the plane's footprint (DEM, cached proxy) for cameras
    // without a shipped precompute for this pose — only the camera the user
    // is looking at ever asks.
    void parts.ground.resolveFootprintGround(record);
    record.activationDone = true;
    parts.rendering.refreshCoverageStyles();
    // The newly active camera leaves the ambient ring (its monitor plane takes
    // over); the freed slot re-fills on this same pass.
    parts.cards.refreshAmbientCards();
    // ADJUST mode follows the active camera.
    layerState._gizmo?.refresh();
    parts.presentation.notifyListeners();
    return CCTV_ACTIVATION_RESULT.ACTIVATED;
  }

  /**
   * Clears the active CCTV camera in place without moving the viewer or
   * disabling the layer. The normal selection-refresh path releases the active
   * projection, emphasis, and probe state while ambient cards remain available.
   * @returns {boolean} True when a camera was deactivated.
   */

  function deactivateActiveCamera() {
    const record = layerState._activeCameraId
      ? layerState._recordById.get(layerState._activeCameraId)
      : null;
    if (!record) return false;
    layerState._activeCameraId = null;
    layerState._autoHopSuspended = true;
    record.activationDone = false;
    parts.geometry.clearProbeClampOnDeactivation(record, (previous) => {
      parts.geometry.applyFrustumGeometry(
        previous,
        parts.ground.groundAltFor(previous),
      );
    });
    parts.rendering.refreshCoverageStyles();
    parts.cards.refreshAmbientCards();
    layerState._gizmo?.refresh();
    parts.presentation.notifyListeners();
    return true;
  }

  /**
   * True only for a clean click that is empty from CCTV's perspective: an
   * active camera exists, ADJUST does not own the pointer, and the scene pick
   * carries no canonical object ID. Any identified scene object is non-empty,
   * including selectable siblings that do not participate in the pick registry.
   * @param {Object|null} picked - `scene.pick()` result.
   * @param {Object} [context]
   * @param {string|null} [context.activeCameraId]
   * @param {boolean} [context.calibrationMode]
   * @returns {boolean}
   */

  function cctvEmptyClickDeselects(
    picked,
    { activeCameraId = null, calibrationMode = false } = {},
  ) {
    if (!activeCameraId || calibrationMode) return false;
    return resolvePickId(picked) === null;
  }

  /**
   * Extracts a camera ID from a Cesium pick result by checking billboard IDs,
   * primitive IDs, and entity cctvCameraId properties.
   * @param {Object|null} picked - Result from scene.pick().
   * @returns {string|null} Camera ID, or null if the pick is not a CCTV entity.
   */

  function extractPickedCameraId(picked) {
    if (!picked) return null;

    const entity = picked.id?.properties
      ? picked.id
      : picked.primitive?.id?.properties
        ? picked.primitive.id
        : null;
    const maybeProp = entity?.properties?.cctvCameraId;
    if (maybeProp) {
      const value =
        typeof maybeProp.getValue === 'function'
          ? maybeProp.getValue(Cesium.JulianDate.now())
          : maybeProp;
      const record =
        typeof value === 'string' ? layerState._recordById.get(value) : null;
      const ownsCoverageEntity = Boolean(
        record?.coverageEntities?.includes(entity),
      );
      const ownsProjectionEntity =
        record?.projection?.planeEntity === entity ||
        layerState._projectionEntities.some(
          (runtime) =>
            runtime?.cameraId === value && runtime.planeEntity === entity,
        );
      if (record && (ownsCoverageEntity || ownsProjectionEntity)) return value;
    }

    // Camera billboard IDs are intentionally the upstream camera ID, so a
    // sibling may legitimately use the same string. A bare ID match is not
    // ownership proof: require this layer's billboard collection or the exact
    // billboard stored on the record.
    const directId =
      typeof picked.id === 'string'
        ? picked.id
        : typeof picked.primitive?.id === 'string'
          ? picked.primitive.id
          : null;
    const record =
      directId === null ? null : layerState._recordById.get(directId);
    if (!record) return null;
    return picked.primitive === layerState._billboards ||
      picked.primitive === record.billboard
      ? directId
      : null;
  }
  return {
    getActiveRecord,
    bindCctvWorldClickGesture,
    setActiveCamera,
    deactivateActiveCamera,
    cctvEmptyClickDeselects,
    extractPickedCameraId,
  };
}
