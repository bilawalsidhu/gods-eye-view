import { greatCircleMeters } from './geoDistance.js';

/**
 * When the HUD's passive place lookup may spend another reverse geocode or
 * Nearby Places request. Every request is a paid Google call, and the HUD
 * asks on its own whenever the camera settles, so a new view only earns a
 * new lookup once it shows a meaningfully different area: the center has
 * moved by a quarter of the visible width, or the camera's distance to the
 * center has doubled or halved. The width is measured at the view center
 * from that distance, so terrain under the camera and a tilted view scale it
 * as they scale what is on screen.
 */
const MOVE_FRACTION = 0.25;
const RANGE_RATIO = 2;
/** Street-level views still need a small move before they count as new. */
const MIN_SPAN_M = 100;
const DEFAULT_FOV_RAD = Math.PI / 3;

/**
 * Describe the view a lookup answers for.
 * @param {{latitude: number, longitude: number, rangeM: number, fovRad?: number, aspectRatio?: number, tier?: string}} view
 *   `rangeM` is the camera's distance to the view center. `fovRad` and
 *   `aspectRatio` are the Cesium perspective frustum's. `tier` names which
 *   lookups the camera height calls for; a view in another tier is new.
 * @returns {{latitude: number, longitude: number, rangeM: number, spanM: number, tier: string}}
 */
export function placeLookupView({
  latitude,
  longitude,
  rangeM,
  fovRad,
  aspectRatio,
  tier = '',
}) {
  const fov =
    Number.isFinite(fovRad) && fovRad > 0 && fovRad < Math.PI
      ? fovRad
      : DEFAULT_FOV_RAD;
  // Cesium's fov spans the wider screen dimension, so a portrait screen's
  // width is narrower than it.
  const aspect = Number(aspectRatio);
  const horizontalFov =
    Number.isFinite(aspect) && aspect > 0 && aspect < 1
      ? 2 * Math.atan(Math.tan(fov / 2) * aspect)
      : fov;
  const range = Math.max(1, Number(rangeM) || 0);
  return {
    latitude,
    longitude,
    rangeM: range,
    spanM: Math.max(MIN_SPAN_M, 2 * range * Math.tan(horizontalFov / 2)),
    tier,
  };
}

/**
 * Whether `next` shows enough new ground to look its places up again.
 * A missing or unusable previous view always does.
 */
export function placeLookupViewChanged(previous, next) {
  if (!previous || !next || previous.tier !== next.tier) return true;
  const ratio =
    Math.max(previous.rangeM, next.rangeM) /
    Math.min(previous.rangeM, next.rangeM);
  if (!Number.isFinite(ratio) || ratio >= RANGE_RATIO) return true;
  const moved = greatCircleMeters(
    { lat: previous.latitude, lon: previous.longitude },
    { lat: next.latitude, lon: next.longitude },
  );
  return !(moved < MOVE_FRACTION * previous.spanM);
}

/**
 * The viewport samples the HUD geocodes besides the view center: one more
 * point. Sample 0 is the screen center, so it stands in for the center only
 * when the center itself is not geocoded at this height.
 */
export function hudViewportSamples(samples, centerGeocoded) {
  return centerGeocoded ? samples.slice(1, 2) : samples.slice(0, 2);
}
