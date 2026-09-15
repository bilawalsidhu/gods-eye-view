import * as Cesium from 'cesium';
import { transitFeedsInRange } from '../../data/transitFeeds.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  FLOOR_ANCHOR_MAX_ALTITUDE_M,
} from './policy.js';

/** Camera gating: which registered feeds the look-at point falls inside. */
export function createViewport({ state: layerState, services, parts }) {
  function cameraAltitude() {
    const carto = layerState._viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function cameraCenter() {
    const viewer = layerState._viewer;
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene?.globe?.ellipsoid,
    );
    if (rect) {
      const center = Cesium.Rectangle.center(rect);
      return {
        lat: Cesium.Math.toDegrees(center.latitude),
        lon: Cesium.Math.toDegrees(center.longitude),
      };
    }
    const carto = viewer?.camera?.positionCartographic;
    if (carto)
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      };
    return null;
  }

  function gateOpen(altitude) {
    if (layerState._altitudeGateOpen)
      return altitude <= ACTIVATION_EXIT_ALTITUDE_M;
    return altitude <= ACTIVATION_ENTER_ALTITUDE_M;
  }

  /** Whether the camera is close enough that vehicles must sit on the ground floor. */
  function nearGround() {
    return cameraAltitude() <= FLOOR_ANCHOR_MAX_ALTITUDE_M;
  }

  function runProximityCheck() {
    if (!layerState._enabled || !layerState._viewer) return;
    layerState._altitudeGateOpen = gateOpen(cameraAltitude());
    const center = layerState._altitudeGateOpen ? cameraCenter() : null;
    const desired = new Map();
    if (center) {
      for (const feed of transitFeedsInRange(center.lat, center.lon))
        desired.set(feed.id, feed);
      // Hysteresis: a feed already active stays active a little past its edge.
      for (const feed of transitFeedsInRange(
        center.lat,
        center.lon,
        RANGE_SLACK_KM,
      )) {
        if (layerState._activeFeeds.has(feed.id)) desired.set(feed.id, feed);
      }
    }
    for (const feedId of [...layerState._activeFeeds.keys()]) {
      if (!desired.has(feedId)) {
        parts.ingestion.abortFeed(feedId);
        layerState._activeFeeds.delete(feedId);
        layerState._feedStatus.delete(feedId);
        parts.rendering.removeFeedVehicles(feedId);
      }
    }
    for (const [feedId, feed] of desired) {
      if (!layerState._activeFeeds.has(feedId)) {
        layerState._activeFeeds.set(feedId, feed);
        void parts.ingestion.pollFeed(feed, layerState._generation);
      }
    }
    parts.rendering.syncRenderHold();
    services.render.governorRequestRender('transit-proximity');
  }

  function onCameraChanged() {
    clearTimeout(layerState._cameraDebounceTimer);
    layerState._cameraDebounceTimer = setTimeout(() => {
      layerState._cameraDebounceTimer = null;
      runProximityCheck();
    }, CAMERA_DEBOUNCE_MS);
  }

  return {
    cameraAltitude,
    cameraCenter,
    nearGround,
    runProximityCheck,
    onCameraChanged,
  };
}
