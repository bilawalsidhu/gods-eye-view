import * as Cesium from 'cesium';
import { CCTV_FOCUS_RESULT } from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * The ground point the viewer is actually looking at (the map location the
   * operator scrolled/panned onto), not the high-above-surface camera eye.
   * Falls back to the eye position when no surface is under the screen center.
   * @returns {Cesium.Cartographic|null} Ground point being viewed, or null.
   */

  function viewedCartographic() {
    const viewer = layerState._viewer;
    const camera = viewer?.camera;
    if (!camera) return null;
    const scene = viewer.scene;
    if (scene && typeof camera.getPickRay === 'function') {
      const width = scene.canvas?.clientWidth || scene.drawingBufferWidth || 0;
      const height =
        scene.canvas?.clientHeight || scene.drawingBufferHeight || 0;
      if (width > 0 && height > 0) {
        const ray = camera.getPickRay(
          new Cesium.Cartesian2(width / 2, height / 2),
        );
        const picked = ray && scene.globe?.pick?.(ray, scene);
        if (picked) {
          const fromPicked = Cesium.Cartographic.fromCartesian(picked);
          if (fromPicked && Number.isFinite(fromPicked.longitude))
            return fromPicked;
        }
      }
    }
    return camera.positionCartographic || null;
  }

  /**
   * Finds the camera closest to the map location the viewer is currently
   * looking at (screen-center ground point). Never snaps back to a region the
   * operator already left.
   * @returns {string|null} Camera ID of the nearest camera, or null.
   */

  function nearestCameraIdToViewer() {
    const carto = viewedCartographic();
    if (!carto || !layerState._records.length) return null;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);

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
   * Flies the Cesium viewer camera to frame the specified CCTV camera,
   * looking along its heading from above.
   * @param {Cesium.Viewer|null} viewer Cesium viewer that owns the camera.
   * @param {Object|null} record CCTV camera runtime record.
   * @param {number} [duration=2.2] - Flight duration in seconds.
   * @returns {'focused'|'no-active-camera'|'tracking-holds-view'|'cockpit-active'} Focus result.
   */

  function focusCctvRecord(viewer, record, duration = 2.2) {
    if (!viewer || !record) return CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    if (
      typeof document !== 'undefined' &&
      document.body?.classList.contains('cockpit-mode')
    ) {
      console.debug('[Data:CCTV] focus ignored while cockpit owns the camera');
      return CCTV_FOCUS_RESULT.COCKPIT_ACTIVE;
    }
    if (viewer.trackedEntity) {
      console.debug(
        '[Data:CCTV] focus ignored while a tracked entity owns the camera',
      );
      return CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW;
    }
    const { camera } = record;
    const range = Math.max(280, camera.rangeM * 1.18);
    pushCurrentViewToHistory();
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        record.position,
        Math.max(40, camera.rangeM * 0.36),
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          parts.model.toRad(camera.headingDeg),
          parts.model.toRad(-22),
          range,
        ),
        duration: Math.max(0.2, duration || 0),
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      },
    );
    return CCTV_FOCUS_RESULT.FOCUSED;
  }

  function focusCamera(cameraId, duration = 2.2) {
    return focusCctvRecord(
      layerState._viewer,
      layerState._recordById.get(cameraId),
      duration,
    );
  }

  /** Copies the viewer's current camera pose for later restoration. */

  function captureCameraPose() {
    const camera = layerState._viewer?.camera;
    const position = camera?.positionWC?.clone?.();
    if (!position) return null;
    return {
      position,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    };
  }

  function posesEquivalent(a, b) {
    if (!a || !b) return false;
    const wrap = (value) => {
      const half = Math.PI;
      let result = value % (2 * half);
      if (result > half) result -= 2 * half;
      if (result < -half) result += 2 * half;
      return result;
    };
    return (
      Cesium.Cartesian3.distance(a.position, b.position) <= 5 &&
      Math.abs(wrap(a.heading - b.heading)) <= 0.05 &&
      Math.abs(wrap(a.pitch - b.pitch)) <= 0.05 &&
      Math.abs(wrap(a.roll - b.roll)) <= 0.05
    );
  }

  /**
   * Remembers the view being left behind so an explicit camera flight can be
   * undone with the BACK control. Skips an entry identical to the last one
   * (re-focus on the same camera) and drops the forward stack on a new branch.
   * @returns {boolean} True when a new entry was captured.
   */

  function pushCurrentViewToHistory() {
    const pose = captureCameraPose();
    if (!pose) return false;
    const last = layerState._viewHistory.at(-1);
    if (last && posesEquivalent(last, pose)) return false;
    layerState._viewHistory.push(pose);
    if (layerState._viewHistory.length > layerState._viewHistoryLimit) {
      layerState._viewHistory.shift();
    }
    layerState._viewForward.length = 0;
    parts.presentation.notifyListeners();
    return true;
  }

  function restoreCameraPose(pose) {
    const viewer = layerState._viewer;
    if (!viewer || !pose) return false;
    viewer.camera.flyTo({
      destination: pose.position,
      orientation: {
        heading: pose.heading,
        pitch: pose.pitch,
        roll: pose.roll,
      },
      duration: 1.2,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
    return true;
  }

  /** Goes back to the previous camera view. Returns false when history is empty. */

  function historyBack() {
    const prior = layerState._viewHistory.at(-1);
    if (!prior) return false;
    layerState._viewHistory.pop();
    const current = captureCameraPose();
    if (current && !posesEquivalent(current, prior)) {
      layerState._viewForward.push(current);
      if (layerState._viewForward.length > layerState._viewHistoryLimit) {
        layerState._viewForward.shift();
      }
    }
    const restored = restoreCameraPose(prior);
    parts.presentation.notifyListeners();
    return restored;
  }

  /** Goes forward to the view abandoned by the last BACK. */

  function historyForward() {
    const next = layerState._viewForward.at(-1);
    if (!next) return false;
    layerState._viewForward.pop();
    const current = captureCameraPose();
    if (current && !posesEquivalent(current, next)) {
      layerState._viewHistory.push(current);
      if (layerState._viewHistory.length > layerState._viewHistoryLimit) {
        layerState._viewHistory.shift();
      }
    }
    const restored = restoreCameraPose(next);
    parts.presentation.notifyListeners();
    return restored;
  }

  function canGoBack() {
    return layerState._viewHistory.length > 0;
  }

  function canGoForward() {
    return layerState._viewForward.length > 0;
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
    viewedCartographic,
    focusCctvRecord,
    focusCamera,
    maybeAutoHop,
    cctvCycleIndex,
    pushCurrentViewToHistory,
    historyBack,
    historyForward,
    canGoBack,
    canGoForward,
  };
}
