import { offsetEllipsoid } from '../geo/ellipsoid.js';
import { horizonFrom } from '../geo/horizon.js';
import { findCamera, findFrame } from './rendererOf.js';

/**
 * Horizon occluder depth below WGS84 (m): ground can lie below the ellipsoid
 * (NYC −22 m), and an occluder at 0 m would hide the cones around it.
 */
const HORIZON_CULL_DEPTH_M = 1000;
const HORIZON_CULL_ELLIPSOID = offsetEllipsoid(-HORIZON_CULL_DEPTH_M);

/**
 * Hide markers behind the horizon: they skip the depth test, so nothing
 * else stops the far side drawing through the globe. Re-culls before a
 * frame draws after the camera moves; stops when nothing is left to cull.
 * Items are `{position, show}` (`position` ECEF); `onChange` hears the
 * items whose `show` it changed.
 * @param {{getViewer: () => object|null, items: () => Iterable<{position: {x: number, y: number, z: number}, show: boolean}>, onChange?: (changed: object[]) => void}} options
 */
export function createHorizonCull({ getViewer, items, onChange }) {
  let from = null;
  let stopListening = null;

  /**
   * Show what is in front of the horizon, hide the rest; the count seen.
   * `quiet`: `onChange` is not told (the caller draws them next anyway).
   */
  function cull(list, position, quiet = false) {
    const horizon = horizonFrom(position, HORIZON_CULL_ELLIPSOID);
    let seen = 0;
    const changed = [];
    for (const item of list) {
      seen++;
      const show = horizon.isPointVisible(item.position);
      if (item.show !== show) {
        item.show = show;
        changed.push(item);
      }
    }
    if (changed.length && !quiet) onChange?.(changed);
    return seen;
  }

  /** Cull everything from the camera at `position`; the count seen. */
  function cullAll(position) {
    from = { x: position.x, y: position.y, z: position.z };
    return cull(items(), position);
  }

  /** The camera's position, or null without one (or with no finite height). */
  function eyeOf(viewer) {
    const pose = viewer ? findCamera(viewer)?.pose() : null;
    return (
      (pose && Number.isFinite(pose.height) ? pose.position : null) ?? null
    );
  }
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

  function onPreRender() {
    const position = eyeOf(getViewer());
    if (!position || (from && same(from, position))) return;
    if (!cullAll(position)) stop();
  }

  /**
   * Cull `added` items (or all) now, then all again whenever the camera
   * moves. `quiet`: this first cull of `added` does not call `onChange`,
   * for items about to be drawn with their `show`.
   */
  function update(added, { quiet = false } = {}) {
    const viewer = getViewer();
    const position = eyeOf(viewer);
    if (position && !(added ? cull(added, position, quiet) : cullAll(position)))
      return;
    stopListening ||=
      (viewer && findFrame(viewer)?.on('preRender', onPreRender)) || null;
  }

  function stop() {
    stopListening?.();
    stopListening = null;
    from = null;
  }

  return { update, stop };
}
