import { rectangleCenter } from '../../geo/rectangle.js';
import { toDegrees, toRadians } from '../../geo/vector.js';
import { findCamera } from '../../render/rendererOf.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  inflateViewBounds,
} from './policy.js';
import { transitFeedsInRange } from '../../data/transitFeeds.js';

/**
 * Camera-driven feed activation: only the feeds whose coverage circle contains
 * the look-at point are polled, and only below the altitude gate.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  function getCameraAltitude(viewer = state._viewer) {
    const height = findCamera(viewer)?.pose().height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /** Where the camera looks: its view rectangle's middle, else under the eye. */
  function getCameraCenterLatLon(viewer = state._viewer) {
    const camera = findCamera(viewer);
    const rect = camera?.viewRectangle();
    if (rect) {
      const center = rectangleCenter({
        west: toRadians(rect.west),
        south: toRadians(rect.south),
        east: toRadians(rect.east),
        north: toRadians(rect.north),
      });
      return { lat: toDegrees(center.lat), lon: toDegrees(center.lon) };
    }
    const pose = camera?.pose();
    if (pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon))
      return { lat: pose.lat, lon: pose.lon };
    return null;
  }

  function altitudeGateOpen(altitude) {
    if (state._altitudeGateOpen) return altitude <= ACTIVATION_EXIT_ALTITUDE_M;
    return altitude <= ACTIVATION_ENTER_ALTITUDE_M;
  }

  /**
   * Refresh the bounds the per-frame pass uses to decide what is worth
   * animating. Cheap, and only on a settled camera — never per frame.
   */
  function refreshViewBounds() {
    const rect = findCamera(state._viewer)?.viewRectangle();
    state._viewBounds = rect ? inflateViewBounds(rect) : null;
    // The sweep itself is deferred: `marker.show` is a dirty flag, and a drag
    // fires this on every frame, so re-deciding visibility inline would put the
    // whole fleet back into the vertex buffer once a frame — the exact cost
    // this is meant to remove.
    state._visibilityDirty = true;
    state._cameraRevision++;
    parts.rendering.requestVisibility();
  }

  function runProximityCheck() {
    if (
      globalThis.document?.hidden ||
      globalThis.document?.visibilityState === 'hidden'
    )
      return;
    if (!state._enabled || !state._viewer) return;
    refreshViewBounds();
    const altitude = getCameraAltitude();
    state._altitudeGateOpen = altitudeGateOpen(altitude);
    const center = state._altitudeGateOpen ? getCameraCenterLatLon() : null;
    const desired = new Map();
    if (center) {
      for (const feed of transitFeedsInRange(center.lat, center.lon)) {
        desired.set(feed.id, feed);
      }
      // Hysteresis: a feed already active stays active a little past its edge.
      for (const feed of transitFeedsInRange(
        center.lat,
        center.lon,
        RANGE_SLACK_KM,
      )) {
        if (state._activeFeeds.has(feed.id)) desired.set(feed.id, feed);
      }
    }
    for (const feedId of [...state._activeFeeds.keys()]) {
      if (!desired.has(feedId)) {
        state._inFlight.get(feedId)?.controller.abort();
        state._inFlight.delete(feedId);
        state._activeFeeds.delete(feedId);
        state._feedStatus.delete(feedId);
        parts.ingestion.removeFeedVehicles(feedId);
      }
    }
    for (const [feedId, feed] of desired) {
      if (!state._activeFeeds.has(feedId)) {
        state._activeFeeds.set(feedId, feed);
        void parts.ingestion.pollFeed(feed, state._generation);
      }
    }
    parts.ingestion.sweepAgedVehicles(Date.now());
    parts.rendering.syncRenderHold();
    governorRequestRender('transit-proximity');
  }

  function onCameraChanged() {
    // The bounds update immediately; the feed proximity check stays debounced.
    // A person dragging the globe should not wait a third of a second for the
    // vehicles under the cursor to start moving again.
    refreshViewBounds();
    clearTimeout(state._cameraDebounceTimer);
    state._cameraDebounceTimer = setTimeout(() => {
      state._cameraDebounceTimer = null;
      runProximityCheck();
    }, CAMERA_DEBOUNCE_MS);
  }

  return {
    refreshViewBounds,
    getCameraAltitude,
    getCameraCenterLatLon,
    altitudeGateOpen,
    runProximityCheck,
    onCameraChanged,
  };
}
