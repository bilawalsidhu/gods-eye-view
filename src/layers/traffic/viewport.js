import * as Cesium from 'cesium';
import {
  deriveFetchCenter,
  clampBoundsAroundCenter,
} from '../../data/trafficBounds.js';
import {
  MAX_LOOKAT_PULL_KM,
  ACTIVATION_ALTITUDE,
  OVERLAP_THRESHOLD,
  MIN_CENTER_SHIFT_KM,
  TRAFFIC_TIMING_ENABLED,
  FETCH_DEBOUNCE,
} from './policy.js';

export function createViewport({ state: layerState, services, parts, source }) {
  // ─── Camera Monitoring ─────────────────────────────────────

  /**
   * Get the current camera altitude in meters above the ellipsoid.
   * @returns {number} Camera height in meters, or Infinity if unavailable.
   */

  function getCameraAltitude() {
    const carto = layerState._viewer.camera.positionCartographic;
    return carto ? carto.height : Infinity;
  }

  /**
   * Compute the current camera view rectangle in degrees.
   * @returns {{south:number, west:number, north:number, east:number}|null}
   *   Bounding box in degrees, or null if the rectangle cannot be computed.
   */

  function getViewBounds() {
    const rect = layerState._viewer.camera.computeViewRectangle();
    if (!rect) return null;
    return {
      south: Cesium.Math.toDegrees(rect.south),
      west: Cesium.Math.toDegrees(rect.west),
      north: Cesium.Math.toDegrees(rect.north),
      east: Cesium.Math.toDegrees(rect.east),
    };
  }

  /**
   * Derive the road-fetch center from the camera's look-at ground point.
   *
   * C4 fix: at oblique pitch `computeViewRectangle()` spans toward the horizon,
   * so its midpoint can sit tens of km from what the user is looking at. Instead
   * we pick the ellipsoid under the canvas center (`camera.pickEllipsoid` — this
   * works with the globe hidden under Google 3D tiles, where `scene.globe.pick`
   * is NOT reliable), fall back to the camera nadir on a sky/horizon look, and
   * pull horizon-gaze hits back to MAX_LOOKAT_PULL_KM from nadir.
   *
   * @returns {{lat:number, lon:number, source:string}|null} Fetch center in
   *   degrees, or null when the camera position is unavailable.
   */

  function getFetchCenter() {
    const carto = layerState._viewer.camera.positionCartographic;
    if (!carto) return null;
    const nadirLat = Cesium.Math.toDegrees(carto.latitude);
    const nadirLon = Cesium.Math.toDegrees(carto.longitude);

    let hitLat;
    let hitLon;
    const canvas = layerState._viewer.scene.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width > 0 && height > 0) {
      const hit = layerState._viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(width / 2, height / 2),
        Cesium.Ellipsoid.WGS84,
      );
      if (hit) {
        const hitCarto = Cesium.Cartographic.fromCartesian(hit);
        hitLat = Cesium.Math.toDegrees(hitCarto.latitude);
        hitLon = Cesium.Math.toDegrees(hitCarto.longitude);
      }
    }

    return deriveFetchCenter({
      nadirLat,
      nadirLon,
      hitLat,
      hitLon,
      maxPullKm: MAX_LOOKAT_PULL_KM,
    });
  }

  /**
   * Compute the geographic center of a bounding box.
   * @param {{south:number, west:number, north:number, east:number}} bounds
   * @returns {{lat:number, lon:number}} Center point in degrees.
   */

  function getBoundsCenter(bounds) {
    return {
      lat: (bounds.south + bounds.north) / 2,
      lon: (bounds.west + bounds.east) / 2,
    };
  }

  /**
   * Approximate great-circle distance between two points in kilometres.
   *
   * Uses an equirectangular projection (cosine correction on longitude)
   * with the 111 km/degree approximation. Sufficient for the small
   * viewport-center shifts being compared.
   *
   * @param {{lat:number, lon:number}} a - First point.
   * @param {{lat:number, lon:number}} b - Second point.
   * @returns {number} Distance in kilometres.
   */

  function distanceKm(a, b) {
    const dLat = (a.lat - b.lat) * 111;
    const avgLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const dLon = (a.lon - b.lon) * 111 * Math.cos(avgLat);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  /**
   * Check whether two bounding boxes overlap by at least a given fraction of
   * the first box's area. Used to decide if a camera move is large enough to
   * warrant a new road fetch.
   *
   * @param {{south:number, west:number, north:number, east:number}} a - Reference bounds.
   * @param {{south:number, west:number, north:number, east:number}} b - Bounds to compare.
   * @param {number} threshold - Minimum overlap fraction (0-1) relative to `a`.
   * @returns {boolean} True if overlap area / a area >= threshold.
   */

  function boundsOverlap(a, b, threshold) {
    // Compute the intersection rectangle
    const overlapS = Math.max(a.south, b.south);
    const overlapN = Math.min(a.north, b.north);
    const overlapW = Math.max(a.west, b.west);
    const overlapE = Math.min(a.east, b.east);

    // No intersection if the rectangle is degenerate
    if (overlapN <= overlapS || overlapE <= overlapW) return false;

    const overlapArea = (overlapN - overlapS) * (overlapE - overlapW);
    const aArea = (a.north - a.south) * (a.east - a.west);

    return aArea > 0 && overlapArea / aArea >= threshold;
  }

  /**
   * Clamp a bounding box to a maximum span to avoid overloading the Overpass API.
   *
   * The box is centered on the input's midpoint with each axis capped at 0.05
   * degrees (~5.5 km at the equator). This keeps query area and response size
   * manageable while still covering the visible neighbourhood.
   *
   * NOTE (C4): the camera-driven path in `onCameraChanged` centers on the
   * derived look-at point via `clampBoundsAroundCenter` instead; this
   * midpoint-centered variant remains as the internal re-clamp guard in
   * `loadRoadsForBounds` (idempotent on already-clamped bounds).
   *
   * @param {{south:number, west:number, north:number, east:number}} bounds
   * @returns {{south:number, west:number, north:number, east:number}} Clamped bounds.
   */

  function clampBounds(bounds) {
    return clampBoundsAroundCenter(bounds, getBoundsCenter(bounds));
  }

  /**
   * Camera-change handler — the main entry point for viewport-driven road loading.
   *
   * Gating logic:
   *  1. If the camera is above ACTIVATION_ALTITUDE, clear all dots and bail.
   *  2. Clamp the view bounds and compute the viewport center.
   *  3. Skip the fetch if the new viewport significantly overlaps the last-fetched
   *     bounds AND the center has shifted less than MIN_CENTER_SHIFT_KM. This
   *     prevents redundant fetches during small pans.
   *  4. Otherwise, debounce and schedule `loadRoadsForBounds`.
   */

  function onCameraChanged() {
    if (!layerState._enabled) return;

    const alt = getCameraAltitude();

    // Above activation altitude — remove all traffic and stop.
    // Also null the last-fetch gate: otherwise zooming back down to the SAME
    // viewport hits the overlap/center-shift skip in step 3 and the dots
    // (cleared here) never reload (H5). Clearing the gate forces a fresh fetch.
    if (alt > ACTIVATION_ALTITUDE) {
      clearTimeout(layerState._fetchTimeout);
      clearTimeout(layerState._retryTimer);
      layerState._retryTimer = null;
      parts.ingestion.cancelActiveFetch();
      layerState._loadGeneration++;
      layerState._fetching = false;
      layerState._flowPending = 0;
      layerState._roadError = null;
      parts.animation.clearDots();
      layerState._lastBounds = null;
      layerState._lastViewCenter = null;
      return;
    }

    const bounds = getViewBounds();
    if (!bounds) return;
    // C4 fix: center the fetch box on the camera's look-at ground point (with
    // nadir fallback + 12 km horizon-gaze pull-back), NOT the view rectangle's
    // midpoint — at oblique pitch that midpoint drifts toward the horizon.
    const fetchCenter = getFetchCenter();
    const clamped = fetchCenter
      ? clampBoundsAroundCenter(bounds, fetchCenter)
      : clampBounds(bounds);
    const center = getBoundsCenter(clamped);

    // Skip re-fetch when viewport overlap is high and center shift is negligible
    if (
      layerState._lastBounds &&
      layerState._lastViewCenter &&
      boundsOverlap(clamped, layerState._lastBounds, OVERLAP_THRESHOLD) &&
      distanceKm(center, layerState._lastViewCenter) < MIN_CENTER_SHIFT_KM
    ) {
      return;
    }

    // Debounce: wait for camera to settle before triggering a fetch. In debug
    // captures the final changed event that arms this exact timeout is its
    // causal anchor; Cesium's later moveEnd notification is diagnostic only.
    const interactionAnchor = TRAFFIC_TIMING_ENABLED
      ? parts.timing.markTrafficTimingCameraChange()
      : null;
    clearTimeout(layerState._fetchTimeout);
    layerState._fetchTimeout = setTimeout(
      () => layerState._loadRoadsForBounds(clamped, alt, interactionAnchor),
      FETCH_DEBOUNCE,
    );
  }
  return {
    getCameraAltitude,
    getViewBounds,
    getFetchCenter,
    getBoundsCenter,
    distanceKm,
    boundsOverlap,
    clampBounds,
    onCameraChanged,
  };
}
