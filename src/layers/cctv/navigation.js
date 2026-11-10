import * as geo from '../../geo/index.js';
import { CCTV_FOCUS_RESULT } from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Finds the camera closest to the Cesium viewer's current position.
   * @returns {string|null} Camera ID of the nearest camera, or null.
   */

  function nearestCameraIdToViewer() {
    const carto = parts.renderer?.cameraCartographic();
    if (!carto || !layerState._records.length) return null;
    const lat = geo.math.toDegrees(carto.latitude);
    const lon = geo.math.toDegrees(carto.longitude);

    let best = null;
    for (const record of layerState._records) {
      const distKm = parts.model.haversineKm(
        lat,
        lon,
        record.camera.lat,
        record.camera.lon,
      );
      if (!best || distKm < best.distKm) {
        best = { id: record.camera.id, distKm };
      }
    }
    return best?.id || null;
  }

  /**
   * The camera the layer opens on when none is selected: the one nearest the
   * viewer, or the first record when the viewer has no position yet.
   * @returns {string|null} Camera ID, or null when the catalog is empty.
   */

  function openingCameraId() {
    return (
      nearestCameraIdToViewer() || layerState._records[0]?.camera?.id || null
    );
  }

  /**
   * After a settled move, moves the opening camera to the one nearest the
   * view, until someone chooses a camera. A shared view's flight lands after
   * enable() picked from the startup view.
   * @returns {boolean} True when the active camera changed.
   */

  function reopenNearestCamera() {
    if (!layerState._openingCameraProvisional || !layerState._enabled)
      return false;
    const nearest = nearestCameraIdToViewer();
    if (!nearest || nearest === layerState._activeCameraId) return false;
    parts.selection.setActiveCamera(nearest);
    // setActiveCamera ends the opening pick; this is still that pick.
    layerState._openingCameraProvisional = true;
    return true;
  }

  /**
   * Flies the Cesium viewer camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {Cesium.Viewer|null} viewer Cesium viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(renderer, record, duration = 2.2) {
    if (!renderer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    ) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (renderer.following()) {
      console.debug(
        '[Data:CCTV] focus ignored while a tracked entity owns the camera',
      );
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    }
    renderer.focus(record, duration);
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  function focusCamera(cameraId, duration = 2.2) {
    return focusCctvRecord(
      parts.renderer?.ready ? parts.renderer : null,
      layerState._recordById.get(cameraId),
      duration,
    );
  }

  /**
   * Advances to the next camera if auto-hop is enabled and the hop interval
   * has elapsed. If the viewer has panned to a new region since the last hop,
   * snaps to the nearest camera instead of cycling sequentially.
   * @param {number} nowMs - Current timestamp in milliseconds.
   */

  function maybeAutoHop(nowMs) {
    if (
      !layerState._autoHop ||
      layerState._autoHopSuspended ||
      !layerState._enabled ||
      layerState._records.length < 2
    )
      return;
    if (nowMs - layerState._lastHopAt < layerState._autoHopSec * 1000) return;

    const viewKey = parts.model.currentViewContext();
    const viewChanged = viewKey !== layerState._lastViewContext;
    layerState._lastViewContext = viewKey;

    if (viewChanged) {
      const nearest = nearestCameraIdToViewer();
      if (nearest && nearest !== layerState._activeCameraId) {
        // Use setActiveCamera so the full activation path runs (obstruction
        // probe, projection runtime, geometry rewrite) — previously bypassed
        // with a bare assignment
        parts.selection.setActiveCamera(nearest);
        layerState._lastHopAt = nowMs;
        return;
      }
    }

    const nextIdx = cctvCycleIndex(
      layerState._records.findIndex(
        (record) => record.camera.id === layerState._activeCameraId,
      ),
      1,
      layerState._records.length,
    );
    parts.selection.setActiveCamera(layerState._records[nextIdx].camera.id);
    layerState._lastHopAt = nowMs;
  }

  /**
   * Resolves a catalog cycle target, including the explicit no-selection state.
   * NEXT from null selects the first record; PREV selects the last.
   * @param {number} currentIdx
   * @param {number} step
   * @param {number} count
   * @returns {number}
   */

  function cctvCycleIndex(currentIdx, step, count) {
    const total = Number.isFinite(count) ? Math.floor(count) : 0;
    if (total <= 0) return -1;
    const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
    if (!Number.isFinite(currentIdx) || currentIdx < 0) {
      return delta < 0 ? total - 1 : 0;
    }
    return (((Math.floor(currentIdx) + delta) % total) + total) % total;
  }
  return {
    nearestCameraIdToViewer,
    openingCameraId,
    reopenNearestCamera,
    focusCctvRecord,
    focusCamera,
    maybeAutoHop,
    cctvCycleIndex,
  };
}
