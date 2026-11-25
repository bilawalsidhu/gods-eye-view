import {
  CCTV_COUNT_CARD_SOURCE_ID,
  CCTV_OVERLAY_SOURCE_ID,
} from '../../data/cctvCards.js';
import { isTrackingClickGesture } from '../../data/trackingClickGesture.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { CCTV_ACTIVATION_RESULT } = services.activation;
  const {
    resolvePickId,
    findPickOwner,
    isOwnedByOtherLayer,
    isUnderOtherCard,
  } = services.picking;
  const OWN_CARD_SOURCES = [CCTV_OVERLAY_SOURCE_ID, CCTV_COUNT_CARD_SOURCE_ID];

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

  /** Whether another layer's scene object owns the click at this count. */
  function sceneTakesCountClick(event) {
    const top = event.topHit;
    if (!top) return false;
    const drawHit = event.drawHit;
    if (drawHit) {
      // Unowned fills, such as earthquake discs, let the count take the click.
      if (parts.rendering.extractPickedCameraId(drawHit)) return false;
      const id = resolvePickId(drawHit);
      return id !== null && Boolean(isOwnedByOtherLayer?.('cctv', id));
    }
    const id = resolvePickId(top);
    return id !== null && findPickOwner?.(id) !== 'cctv';
  }

  /** Leave other layers' cards to the caller since clickCard also calls this. */
  function clickedCount(event) {
    if (
      !isTrackingClickGesture(event.gesture) ||
      !layerState._enabled ||
      event.overlay
    )
      return null;
    const cell = layerState._counts?.pickedCell(event.screenPosition);
    if (!cell) return null;
    const { x, y } = event.screenPosition;
    if (
      layerState._cctvOverlayHost?.hitTest(x, y, {
        sourceId: CCTV_OVERLAY_SOURCE_ID,
      })?.entryId
    )
      return null;
    return sceneTakesCountClick(event) ? null : cell;
  }

  /** The count marker as the card on top of a click it takes, for every layer's clickCard. */
  function countClickCard(event) {
    const cell = clickedCount(event);
    return cell
      ? { sourceId: CCTV_COUNT_CARD_SOURCE_ID, entryId: String(cell.key ?? '') }
      : null;
  }

  /**
   * Bind CCTV activation to clean taps. Drag-like and long-press gestures do
   * not reach camera activation or focus dispatch.
   * @param {import('../../input/dispatcher.js').InputDispatcher} input
   * @param {(event: import('../../input/dispatcher.js').ClickEvent) => void} onClick
   *   Accepted CCTV click callback.
   * @returns {() => void} Unsubscribe.
   */

  function bindCctvWorldClickGesture(input, onClick) {
    return input.onClick((event) => {
      if (!isTrackingClickGesture(event.gesture)) return;
      const cell = clickedCount(event);
      // Another layer's card or label painted above the count takes the click.
      if (cell && !isUnderOtherCard?.(event, OWN_CARD_SOURCES)) {
        parts.navigation.zoomToCell(cell);
        return;
      }
      onClick(event);
    });
  }

  /**
   * Sets the active camera by ID, initializes its projection runtime, refreshes
   * its frame, and updates styles.
   * @param {string} cameraId - ID of the camera to activate.
   * @param {Object} [options]
   * @param {boolean} [options.opening=false] - The opening camera following
   *   the view, not someone's pick: settled moves may still replace it.
   * @returns {'activated'|'unchanged'|'not-found'} Discriminated activation result.
   */

  function setActiveCamera(cameraId, { opening = false } = {}) {
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
      // Picking the camera a settled move re-opened is still a pick: later
      // settled moves must leave it alone.
      if (!opening) layerState._openingCameraProvisional = false;
      // Browser-only feeds have a separate player; a reselect retries it
      // without re-running activation or touching the projection geometry.
      if (parts.model.isBrowserOverlayCamera(record.camera)) {
        layerState._activeCameraReselection += 1;
        parts.presentation.notifyListeners();
      }
      return CCTV_ACTIVATION_RESULT.UNCHANGED;
    }
    layerState._activeCameraId = cameraId;
    layerState._autoHopSuspended = false;
    layerState._openingCameraProvisional = opening;
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
    // §9.1: one obstruction probe per activation, cast before the geometry
    // pass; its range clamp lands a microtask later, before the next frame,
    // rewriting the geometry and asking again for the footprint ground. A
    // FIRST-EVER activation (no real ground sample yet) probes from the
    // catalog-prior altitude — if that prior is off, the clamp is measured
    // from a shifted origin, but a re-activation after the one-shot snap
    // lands re-probes from real ground, so it self-corrects.
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
    // The active icon always shows and the previous one rejoins its cell.
    // Restyle coverage after the view pass sets grouping. Its coverage
    // neighbours join the working set and are queued for grounding.
    parts.rendering.refreshHorizonCulling();
    parts.rendering.refreshCoverageStyles();
    parts.geometryQueue.enqueueViewGeometry();
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
    layerState._openingCameraProvisional = false;
    record.activationDone = false;
    parts.geometry.clearProbeClampOnDeactivation(record, (previous) => {
      parts.geometry.applyFrustumGeometry(
        previous,
        parts.ground.groundAltFor(previous),
      );
    });
    parts.rendering.refreshHorizonCulling();
    parts.rendering.refreshCoverageStyles();
    parts.geometryQueue.enqueueViewGeometry();
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
   * The camera a scene pick result is, or null: read by the rendering part,
   * which owns the scene objects the pick names.
   * @param {Object|null} picked - Result from a scene pick.
   * @returns {string|null}
   */

  function extractPickedCameraId(picked) {
    return parts.rendering.extractPickedCameraId(picked);
  }
  return {
    getActiveRecord,
    bindCctvWorldClickGesture,
    countClickCard,
    setActiveCamera,
    deactivateActiveCamera,
    cctvEmptyClickDeselects,
    extractPickedCameraId,
  };
}
