/**
 * Taking the camera to a place, and cutting to it when the user has asked for no motion.
 *
 * A camera flight is motion, so `prefers-reduced-motion: reduce` is honoured by arriving
 * instantly rather than by animating faster. That is the whole reason this is a module and
 * not two lines at the call site: a shorter flight is still a moving picture, and the
 * setting is a statement about vestibular symptoms rather than about taste.
 *
 * The setting is read at the moment of each flight, not once at start-up. A user who turns
 * it on mid-session gets the cut on the next search rather than after a reload.
 */

import { Cartesian3 } from 'cesium';

import type { Point } from '../types/entities';

/**
 * Flight time in seconds.
 *
 * Long enough to see where the camera came from, which is what stops a fly-to reading as a
 * teleport and losing the user's sense of place. Cesium's own default is a distance-scaled
 * value that runs to several seconds across a globe-spanning jump, which is too slow to sit
 * behind a typeahead.
 */
export const FLIGHT_SECONDS = 1.6;

/**
 * The bit of the globe handle a flight needs.
 *
 * Structural rather than the whole `GlobeHandle`, so a test drives it with two functions and
 * a counter instead of a WebGL context.
 */
export interface CameraTarget {
  viewer: {
    camera: {
      flyTo: (options: { destination: Cartesian3; duration: number; complete: () => void }) => void;
      setView: (options: { destination: Cartesian3 }) => void;
    };
  };
  requestRender: () => void;
}

/** Whether the user has asked the system for no animation. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Put the camera over a point at a given height.
 *
 * `altitudeM` is the camera's height above the ellipsoid, not the target's. A city has no
 * altitude and an airborne aircraft's own altitude would put the camera inside it, so the
 * point's `altitude_m` is deliberately ignored here.
 *
 * The render request on completion is not redundant. `requestRenderMode` is on, so the scene
 * draws when something asks it to; Cesium's own camera-changed check covers the frames during
 * the tween, and this covers the last one, where the tween has finished moving the camera and
 * there is nothing left to notice the change.
 */
export function flyToPoint(
  target: CameraTarget,
  point: Point,
  altitudeM: number,
  reducedMotion: boolean = prefersReducedMotion(),
): void {
  const destination = Cartesian3.fromDegrees(point.lon, point.lat, altitudeM);
  if (reducedMotion) {
    target.viewer.camera.setView({ destination });
    target.requestRender();
    return;
  }
  target.viewer.camera.flyTo({
    destination,
    duration: FLIGHT_SECONDS,
    complete: target.requestRender,
  });
}
