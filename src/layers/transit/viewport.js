import * as Cesium from 'cesium';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  WIDE_VIEW_ENTER_ALTITUDE_M,
  WIDE_VIEW_EXIT_ALTITUDE_M,
  inflateViewBounds,
} from './policy.js';
import {
  transitFeedsInRange,
  transitFeedsInView,
} from '../../data/transitFeeds.js';

/** Screen points (fractions of width and height) the wide-view footprint picks: corners and edge midpoints. */
const FOOTPRINT_SAMPLES = Object.freeze([
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
]);

/**
 * Camera-driven feed activation, only below the altitude gate: a feed is
 * polled when its coverage holds the look-at point, and, in a wide view, when
 * its coverage reaches into the ground on screen.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts }) {
  const { governorRequestRender } = services.render;

  function getCameraAltitude(viewer = state._viewer) {
    const carto = viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function viewRectangle(viewer = state._viewer) {
    return (
      viewer?.camera?.computeViewRectangle?.(viewer.scene.globe?.ellipsoid) ??
      null
    );
  }

  function getCameraCenterLatLon(
    viewer = state._viewer,
    rect = viewRectangle(viewer),
  ) {
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
   * The ground on screen, as a rectangle in degrees: the bounds of the
   * screen's corners and edge midpoints picked on the ellipsoid. Null when
   * any of them is sky: a view that reaches the horizon shows no bounded
   * patch of ground and keeps the centre rule.
   */
  function getWideViewRect(viewer = state._viewer) {
    const camera = viewer?.camera;
    const width = viewer?.scene?.canvas?.clientWidth;
    const height = viewer?.scene?.canvas?.clientHeight;
    if (
      typeof camera?.pickEllipsoid !== 'function' ||
      !(width > 0) ||
      !(height > 0)
    )
      return null;
    const ellipsoid = viewer.scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;
    const lats = [];
    const lons = [];
    for (const [x, y] of FOOTPRINT_SAMPLES) {
      const hit = camera.pickEllipsoid(
        new Cesium.Cartesian2(x * width, y * height),
        ellipsoid,
      );
      if (!hit) return null;
      const carto = ellipsoid.cartesianToCartographic(hit);
      lats.push(Cesium.Math.toDegrees(carto.latitude));
      lons.push(Cesium.Math.toDegrees(carto.longitude));
    }
    // The narrowest longitude arc holding every sample leaves out the widest
    // gap between neighbours; west > east when it crosses the antimeridian.
    lons.sort((a, b) => a - b);
    let gap = lons[0] + 360 - lons[lons.length - 1];
    let west = lons[0];
    let east = lons[lons.length - 1];
    for (let i = 1; i < lons.length; i++) {
      if (lons[i] - lons[i - 1] > gap) {
        gap = lons[i] - lons[i - 1];
        west = lons[i];
        east = lons[i - 1];
      }
    }
    let south = Math.min(...lats);
    let north = Math.max(...lats);
    // Samples all the way round the globe: the screen holds a pole.
    if (gap < 180) {
      west = -180;
      east = 180;
      if (south + north > 0) north = 90;
      else south = -90;
    }
    return { south, north, west, east };
  }

  function altitudeGateOpen(altitude) {
    if (state._altitudeGateOpen) return altitude <= ACTIVATION_EXIT_ALTITUDE_M;
    return altitude <= ACTIVATION_ENTER_ALTITUDE_M;
  }

  function wideViewOn(altitude) {
    if (state._wideView) return altitude >= WIDE_VIEW_EXIT_ALTITUDE_M;
    return altitude >= WIDE_VIEW_ENTER_ALTITUDE_M;
  }

  /**
   * Refresh the bounds the per-frame pass uses to decide what is worth
   * animating. Cheap, and only on a settled camera — never per frame.
   */
  function refreshViewBounds(rect = viewRectangle()) {
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
    return rect;
  }

  function runProximityCheck() {
    if (
      globalThis.document?.hidden ||
      globalThis.document?.visibilityState === 'hidden'
    )
      return;
    if (!state._enabled || !state._viewer) return;
    const rect = refreshViewBounds();
    const altitude = getCameraAltitude();
    state._altitudeGateOpen = altitudeGateOpen(altitude);
    state._wideView = state._altitudeGateOpen && wideViewOn(altitude);
    const center = state._altitudeGateOpen
      ? getCameraCenterLatLon(state._viewer, rect)
      : null;
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
      const wide = state._wideView ? getWideViewRect() : null;
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
    getWideViewRect,
    altitudeGateOpen,
    wideViewOn,
    runProximityCheck,
    onCameraChanged,
  };
}
