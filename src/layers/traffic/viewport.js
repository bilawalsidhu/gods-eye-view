import { createReticleFootprint } from './footprint.js';
import * as geo from '../../geo/index.js';
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
  const reticleFootprint = createReticleFootprint();
  // ─── Camera Monitoring ─────────────────────────────────────

  /**
   * Get the current camera altitude in meters above the ellipsoid.
   * @returns {number} Camera height in meters, or Infinity if unavailable.
   */

  function getCameraAltitude() {
    const carto = layerState._engine?.camera.pose().cartographic;
    return carto ? carto.height : Infinity;
  }

  /**
   * Compute the current camera view rectangle in degrees.
   * @returns {{south:number, west:number, north:number, east:number}|null}
   *   Bounding box in degrees, or null if the rectangle cannot be computed.
   */

  function getViewBounds() {
    const rect = layerState._engine?.camera.viewRectangle();
    if (!rect) return null;
    return {
      south: geo.math.toDegrees(rect.south),
      west: geo.math.toDegrees(rect.west),
      north: geo.math.toDegrees(rect.north),
      east: geo.math.toDegrees(rect.east),
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
    const carto = layerState._engine?.camera.pose().cartographic;
    if (!carto) return null;
    const nadirLat = geo.math.toDegrees(carto.latitude);
    const nadirLon = geo.math.toDegrees(carto.longitude);

    let hitLat;
    let hitLon;
    const canvas = layerState._engine.host.canvas;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width > 0 && height > 0) {
      const hit = layerState._engine.camera.pickEllipsoid(
        geo.cartesian2.create(width / 2, height / 2),
      );
      if (hit) {
        const hitCarto = geo.cartographic.fromCartesian(hit);
        hitLat = geo.math.toDegrees(hitCarto.latitude);
        hitLon = geo.math.toDegrees(hitCarto.longitude);
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
    return bounds.coverage
      ? bounds
      : clampBoundsAroundCenter(bounds, getBoundsCenter(bounds));
  }

  /** Debounce camera events and sample the actual settled view, including final flight steps. */
  function onCameraChanged(options) {
    if (
      !layerState._enabled ||
      layerState._waitForScene ||
      layerState._sceneContext?.viewReady === false
    )
      return;
    clearTimeout(layerState._fetchTimeout);
    if (getCameraAltitude() > ACTIVATION_ALTITUDE) {
      clearTimeout(layerState._retryTimer);
      layerState._retryTimer = null;
      parts.ingestion.cancelActiveFetch();
      layerState._loadGeneration++;
      layerState._fetching = false;
      layerState._flowPending = 0;
      layerState._roadError = null;
      // Nothing is drawn up here, cached or not.
      layerState._flowStale = false;
      layerState._flowOldestTileAt = null;
      parts.animation.clearDots();
      layerState._lastBounds = null;
      layerState._lastViewCenter = null;
      return;
    }
    const interactionAnchor = TRAFFIC_TIMING_ENABLED
      ? parts.timing.markTrafficTimingCameraChange()
      : null;
    layerState._fetchTimeout = setTimeout(
      () => {
        if (
          !layerState._enabled ||
          layerState._waitForScene ||
          layerState._sceneContext?.viewReady === false
        )
          return;
        const alt = getCameraAltitude();
        if (alt > ACTIVATION_ALTITUDE) return onCameraChanged();
        const footprint = reticleFootprint(layerState._engine, alt);
        const bounds = footprint || getViewBounds();
        if (!bounds) return;
        const center = footprint ? null : getFetchCenter();
        const clamped =
          footprint ||
          (center
            ? clampBoundsAroundCenter(bounds, center)
            : clampBounds(bounds));
        const previous = layerState._lastBounds;
        const sameCoverage = clamped.coverage
          ? previous?.coverage?.key === clamped.coverage.key &&
            previous.coverage.viewKey === clamped.coverage.viewKey
          : previous &&
            layerState._lastViewCenter &&
            boundsOverlap(clamped, previous, OVERLAP_THRESHOLD) &&
            distanceKm(getBoundsCenter(clamped), layerState._lastViewCenter) <
              MIN_CENTER_SHIFT_KM;
        if (
          sameCoverage &&
          !layerState._roadPartial &&
          !layerState._detailError &&
          !layerState._roadError
        ) {
          if (
            Math.abs(alt - layerState._lastRenderAltitude) > 100 &&
            layerState._roads.length
          )
            parts.rendering.renderRoadsForAltitude(
              layerState._roads,
              alt,
              'Cached zoom',
            );
          return;
        }
        return layerState._loadRoadsForBounds(clamped, alt, interactionAnchor);
      },
      options?.immediate === true ? 0 : FETCH_DEBOUNCE,
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
