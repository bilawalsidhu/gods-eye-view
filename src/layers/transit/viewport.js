import { rectangleCenter } from '../../geo/rectangle.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { toDegrees, toRadians } from '../../geo/vector.js';
import { canvasOf, findCamera, findQuery } from '../../render/rendererOf.js';
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
    const height = findCamera(viewer)?.pose().height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /**
   * Where the camera looks: its view rectangle's middle (degrees; `rect`
   * when the caller has read it already), else under the eye.
   */
  function getCameraCenterLatLon(viewer = state._viewer, rect) {
    const camera = findCamera(viewer);
    if (rect === undefined) rect = camera?.viewRectangle();
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

  /**
   * The ground on screen, as a rectangle in degrees: the bounds of the
   * screen's corners and edge midpoints picked on the ellipsoid. Null when
   * any of them is sky: a view that reaches the horizon shows no bounded
   * patch of ground and keeps the centre rule.
   */
  function getWideViewRect(viewer = state._viewer) {
    const query = findQuery(viewer);
    const canvas = canvasOf(viewer);
    const width = canvas?.clientWidth;
    const height = canvas?.clientHeight;
    if (
      typeof query?.pickEllipsoid !== 'function' ||
      !(width > 0) ||
      !(height > 0)
    )
      return null;
    const lats = [];
    const lons = [];
    for (const [x, y] of FOOTPRINT_SAMPLES) {
      const hit = query.pickEllipsoid(x * width, y * height);
      const ground = hit && toLonLatH(hit);
      if (!ground) return null;
      lats.push(ground.lat);
      lons.push(ground.lon);
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
  function refreshViewBounds() {
    const rect = findCamera(state._viewer)?.viewRectangle() ?? null;
    state._viewBounds = rect ? inflateViewBounds(rect) : null;
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
    const wasGateOpen = state._altitudeGateOpen;
    state._altitudeGateOpen = altitudeGateOpen(altitude);
    let changed = state._altitudeGateOpen !== wasGateOpen;
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
    // A vehicle a first-person view rides keeps its feed polled.
    const held = state._vehicles.get(state._cockpitSubjectKey);
    if (held && state._activeFeeds.has(held.feedId))
      desired.set(held.feedId, state._activeFeeds.get(held.feedId));
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
    wideViewOn,
    runProximityCheck,
    onCameraChanged,
  };
}
