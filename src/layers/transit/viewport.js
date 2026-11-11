import * as geo from '../../geo/index.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  inflateViewBounds,
} from './policy.js';
import { transitFeedsInRange } from '../../data/transitFeeds.js';
import { viewRectangleCenter } from '../shared/viewRectangle.js';

/**
 * Camera-driven feed activation: only the feeds whose coverage circle contains
 * the look-at point are polled, and only below the altitude gate.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  function getCameraAltitude() {
    const carto = parts.renderer?.cameraCartographic();
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function getCameraCenterLatLon() {
    const rect = parts.renderer?.viewRectangle();
    if (rect) {
      const center = viewRectangleCenter(rect);
      return {
        lat: geo.math.toDegrees(center.latitude),
        lon: geo.math.toDegrees(center.longitude),
      };
    }
    const carto = parts.renderer?.cameraCartographic();
    if (carto) {
      return {
        lat: geo.math.toDegrees(carto.latitude),
        lon: geo.math.toDegrees(carto.longitude),
      };
    }
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
    const rect = parts.renderer?.viewRectangle();
    state._viewBounds = rect
      ? inflateViewBounds({
          south: geo.math.toDegrees(rect.south),
          north: geo.math.toDegrees(rect.north),
          west: geo.math.toDegrees(rect.west),
          east: geo.math.toDegrees(rect.east),
        })
      : null;
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
    if (
      !state._enabled ||
      !parts.renderer?.ready ||
      state._sceneContext?.viewReady === false
    )
      return;
    refreshViewBounds();
    const altitude = getCameraAltitude();
    const wasGateOpen = state._altitudeGateOpen;
    state._altitudeGateOpen = altitudeGateOpen(altitude);
    let changed = state._altitudeGateOpen !== wasGateOpen;
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
        changed = true;
      }
    }
    // Nothing is left on the map to date.
    if (desired.size === 0) state._lastUpdate = null;
    for (const [feedId, feed] of desired) {
      if (!state._activeFeeds.has(feedId)) {
        state._activeFeeds.set(feedId, feed);
        void parts.ingestion.pollFeed(feed, state._generation);
        changed = true;
      }
    }
    parts.ingestion.sweepAgedVehicles(Date.now());
    parts.rendering.syncRenderHold();
    governorRequestRender('transit-proximity', parts.renderer?.engine);
    // Repaint now: the row follows the camera, the manager tick is 15 s.
    if (changed) state._dataManager?.refreshLayerStats?.('transit');
  }

  function onCameraChanged() {
    if (state._sceneContext?.viewReady === false) return;
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
