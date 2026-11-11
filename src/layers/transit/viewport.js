import * as Cesium from 'cesium';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  WIDE_VIEW_ALTITUDE_M,
  WIDE_VIEW_MAX_SPAN_DEG,
  inflateViewBounds,
} from './policy.js';
import {
  transitFeedsInRange,
  transitFeedsInView,
} from '../../data/transitFeeds.js';

/**
 * Camera-driven feed activation, only below the altitude gate: a feed is
 * polled when its coverage holds the look-at point, and, in a wide view, when
 * its coverage reaches into the visible rectangle.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  function getCameraAltitude(viewer = state._viewer) {
    const carto = viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function getCameraCenterLatLon(viewer = state._viewer) {
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (rect) {
      const center = Cesium.Rectangle.center(rect);
      return {
        lat: Cesium.Math.toDegrees(center.latitude),
        lon: Cesium.Math.toDegrees(center.longitude),
      };
    }
    const carto = viewer?.camera?.positionCartographic;
    if (carto) {
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      };
    }
    return null;
  }

  /**
   * The visible rectangle (degrees) of a wide, map-like view, or null for a
   * close view, a horizon-grazing oblique one or none at all.
   */
  function getWideViewRect(altitude, viewer = state._viewer) {
    if (!(altitude >= WIDE_VIEW_ALTITUDE_M)) return null;
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (!rect) return null;
    const view = {
      south: Cesium.Math.toDegrees(rect.south),
      north: Cesium.Math.toDegrees(rect.north),
      west: Cesium.Math.toDegrees(rect.west),
      east: Cesium.Math.toDegrees(rect.east),
    };
    const lonSpan =
      view.east >= view.west
        ? view.east - view.west
        : view.east + 360 - view.west;
    if (
      view.north - view.south > WIDE_VIEW_MAX_SPAN_DEG.lat ||
      lonSpan > WIDE_VIEW_MAX_SPAN_DEG.lon
    )
      return null;
    return view;
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
    const viewer = state._viewer;
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    state._viewBounds = rect
      ? inflateViewBounds({
          south: Cesium.Math.toDegrees(rect.south),
          north: Cesium.Math.toDegrees(rect.north),
          west: Cesium.Math.toDegrees(rect.west),
          east: Cesium.Math.toDegrees(rect.east),
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
    if (!state._enabled || !state._viewer) return;
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
      const wide = getWideViewRect(altitude);
      if (wide) {
        for (const feed of transitFeedsInView(wide)) {
          desired.set(feed.id, feed);
        }
        for (const feed of transitFeedsInView(wide, RANGE_SLACK_KM)) {
          if (state._activeFeeds.has(feed.id)) desired.set(feed.id, feed);
        }
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
    governorRequestRender('transit-proximity');
    // Repaint now: the row follows the camera, the manager tick is 15 s.
    if (changed) state._dataManager?.refreshLayerStats?.('transit');
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
    getWideViewRect,
    altitudeGateOpen,
    runProximityCheck,
    onCameraChanged,
  };
}
