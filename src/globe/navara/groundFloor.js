// Keeps the Navara camera above the ground. Navara 0.2.1's camera controller
// has no terrain or 3D-tile collision: its only zoom limit is
// minimumZoomDistance, a distance from the Earth's centre (default: the
// semi-minor axis), so a wheel zoom near the ground goes through it. Cesium's
// controller stops at the surface.
//
// Each frame (engine preRender, after the camera model reads Navara's
// camera), while the camera is free (no flight running, no lookAt target,
// camera inputs on) and below MAX_HEIGHT:
// - the ground under the camera is sampled (surface.sampleHeight: tiles,
//   else terrain; else the ellipsoid), at most every RESAMPLE_MS or after a
//   RESAMPLE_METRES move;
// - Navara's own clamp follows it (minimumZoomDistance = geocentric radius of
//   the ground point + MIN_ABOVE), so the wheel stops smoothly; it is sent
//   only when it moves more than CLAMP_STEP, and reset to Navara's default
//   while a flight runs or the camera is high, so a stale clamp from another
//   latitude can never hold the camera up;
// - a camera still below ground + MIN_ABOVE is lifted straight up, keeping
//   its orientation.
// The floor only ever lifts, so it cannot oscillate with the shell's ground
// guard (src/cameraGroundGuard.js), which also only lifts, by camera.flyTo;
// during that flight the floor stands aside.

import * as geo from '../../geo/index.js';

const { cartesian3, cartographic } = geo;
const WGS84 = geo.ellipsoid.WGS84;

export const GROUND_FLOOR = Object.freeze({
  /** Metres the camera stays above the ground. */
  MIN_ABOVE: 30,
  /** Ellipsoid height (m) above which there is no floor. */
  MAX_HEIGHT: 20000,
  /** Change (m) of the clamp radius worth sending to Navara. */
  CLAMP_STEP: 10,
  /** Horizontal move (m) after which the ground is sampled again. */
  RESAMPLE_METRES: 20,
  /** Age (ms) after which the ground is sampled again. */
  RESAMPLE_MS: 250,
  /**
   * Age (ms) before a move resamples: a sample of the ground outside the
   * view costs about 1.6 ms (surface.js), too much for every frame.
   */
  MIN_RESAMPLE_MS: 100,
});

/**
 * @param {{
 *   surface: { sampleHeight: Function, terrainHeight?: Function },
 *   position: () => import('../../geo/index.js').Cartesian3,
 *   isFree: () => boolean,
 *   lift: (position: object) => void,
 *   setMinimumZoomDistance: (distance: number | undefined) => void,
 *   now?: () => number,
 * }} options
 * @returns {{ update: () => boolean, ground: () => number | undefined }}
 *   `update` returns whether it lifted the camera.
 */
export function createGroundFloor({
  surface,
  position,
  isFree,
  lift,
  setMinimumZoomDistance,
  now = () => performance.now(),
}) {
  let sample = null; // { point, at, height }
  let clamp; // the radius last sent, or undefined for Navara's default

  const sendClamp = (radius) => {
    if (radius === undefined) {
      if (clamp === undefined) return;
    } else if (
      clamp !== undefined &&
      Math.abs(radius - clamp) <= GROUND_FLOOR.CLAMP_STEP
    )
      return;
    clamp = radius;
    setMinimumZoomDistance(radius);
  };

  function groundAt(place, at) {
    const point = cartesian3.fromRadians(
      place.longitude,
      place.latitude,
      0,
      WGS84,
    );
    // Again after RESAMPLE_MS, or after a RESAMPLE_METRES move once
    // MIN_RESAMPLE_MS has passed (a pan does not sample every frame).
    if (sample) {
      const age = at - sample.at;
      const moved =
        cartesian3.distance(point, sample.point) >=
        GROUND_FLOOR.RESAMPLE_METRES;
      if (
        age < GROUND_FLOOR.RESAMPLE_MS &&
        !(moved && age >= GROUND_FLOOR.MIN_RESAMPLE_MS)
      )
        return sample.height;
    }
    const height =
      surface.sampleHeight(place) ?? surface.terrainHeight?.(place) ?? 0;
    sample = { point, at, height };
    const ground = cartesian3.fromRadians(
      place.longitude,
      place.latitude,
      height,
      WGS84,
    );
    sendClamp(cartesian3.magnitude(ground) + GROUND_FLOOR.MIN_ABOVE);
    return height;
  }

  function update() {
    if (!isFree()) {
      sendClamp(undefined);
      return false;
    }
    const place = cartographic.fromCartesian(position(), WGS84);
    if (!place || place.height > GROUND_FLOOR.MAX_HEIGHT) {
      sendClamp(undefined);
      sample = null;
      return false;
    }
    const floor = groundAt(place, now()) + GROUND_FLOOR.MIN_ABOVE;
    if (!(place.height < floor)) return false;
    lift(cartesian3.fromRadians(place.longitude, place.latitude, floor, WGS84));
    return true;
  }

  return { update, ground: () => sample?.height };
}
