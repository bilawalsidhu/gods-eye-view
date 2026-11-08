/**
 * @module data/stockFollow
 * @description A double-click on a layer's drawn item follows it, as the
 * default renderer's own double-click followed the entities layers drew
 * before they drew through the draw port: an item with a position is
 * followed, framed as that renderer framed an entity it started following;
 * one without (a line) is zoomed to at once instead. It runs only while the
 * renderer's own double-click follow is on (a tool can hold it off).
 */
import { WGS84 } from '../geo/ellipsoid.js';
import { offsetFromHeadingPitchRange } from '../geo/frames.js';
import { findCamera, findQuery } from '../render/rendererOf.js';

/** The range the default renderer frames a sphere of no size from. */
const MINIMUM_FIT_RANGE_M = 100;

/**
 * Where the camera frames a part it starts following, as the default
 * renderer framed an entity it started following with no view of its own:
 * looking at the bounds' centre, heading north, pitched down 45° (steeper
 * far from the ground), at the range that fits the bounds in view, within
 * the camera's zoom limits. Returned as the eye's offset from the centre,
 * east-north-up there; `at` is where the part stands.
 * @param {{center: {x: number, y: number, z: number}, radius: number}} sphere
 * @param {{x: number, y: number, z: number}} at
 * @param {object} camera The camera port.
 */
export function followViewFrom(sphere, at, camera) {
  const pose = camera.pose?.();
  const fovy = Number.isFinite(pose?.fovy) ? pose.fovy : Math.PI / 3;
  const aspect = Number.isFinite(pose?.aspectRatio) ? pose.aspectRatio : 1;
  const tanPhi = Math.tan(fovy / 2);
  const tanTheta = aspect * tanPhi;
  let range =
    sphere.radius === 0
      ? MINIMUM_FIT_RANGE_M
      : Math.max(sphere.radius / tanTheta, sphere.radius / tanPhi);
  const { minDistance = 0, maxDistance = Infinity } = camera.controls ?? {};
  range = Math.min(Math.max(range, minDistance), maxDistance);
  const factor =
    2 - 1 / Math.max(1, Math.hypot(at.x, at.y, at.z) / WGS84.radii.x);
  return offsetFromHeadingPitchRange(0, (-Math.PI / 4) * factor, range);
}

/**
 * Follow (or zoom to) a layer's item on a double-click.
 * @param {object} options
 * @param {object} options.viewer
 * @param {(viewer: object) => object} options.inputFor The click dispatcher.
 * @param {string} options.name The layer, for warnings.
 * @param {() => boolean} options.enabled Whether the layer takes clicks now.
 * @param {(hit: import('../render/contract/query').Hit) =>
 *   ({key: string, position: () => ({x: number, y: number, z: number}|null),
 *     sphere?: {center: object, radius: number}}
 *   | {zoomTo: {center: object, radius: number}}
 *   | null)} options.targetFor What a hit on one of the layer's items is
 *   followed by (`key`, its live `position`, the bounds it is framed by,
 *   radius 0 by default), or zoomed to (`zoomTo`); null for anything else.
 * @returns {{readonly following: object|null, stop(): void, destroy(): void}}
 */
export function followOnDoubleClick({
  viewer,
  inputFor,
  name,
  enabled,
  targetFor,
}) {
  const input = inputFor(viewer);
  /** The follow a double-click started, while the camera keeps it. */
  let follow = null;
  const off =
    input.onPointer?.('dblclick', (event) => {
      if (!enabled()) return;
      // The renderer's own double-click follow, off while a tool holds it
      // or on a renderer without one.
      if (input.stockEnabled?.('dblclickFollow') !== true) return;
      const hit = findQuery(viewer)?.pick(event.position.x, event.position.y);
      const found = hit && !hit.surface ? targetFor(hit) : null;
      if (!found) return;
      const camera = findCamera(viewer);
      if (!camera) return;
      try {
        if (found.zoomTo) {
          // As the default renderer zoomed to an entity with no position:
          // at once, north up, pitched down 45°, at the range that fits it
          // in view. Following nothing then, as that zoom stopped any
          // follow first.
          if (camera.followed) camera.follow(null);
          camera.flyToBounds(found.zoomTo, { durationS: 0 });
          return;
        }
        const at = found.position();
        if (!at) return;
        const target = {
          key: found.key,
          position: found.position,
          frame: 'enu',
          viewFrom: followViewFrom(
            found.sphere ?? { center: at, radius: 0 },
            at,
            camera,
          ),
        };
        camera.follow(target);
        follow = target;
      } catch (error) {
        // A camera that cannot follow leaves the view where it is, as a
        // viewer without entity tracking did.
        console.warn(`${name}: cannot follow`, error);
      }
    }) ?? null;
  return {
    get following() {
      return follow && findCamera(viewer)?.followed === follow ? follow : null;
    },
    /** Stop a follow this started, if the camera still keeps it. */
    stop() {
      const camera = findCamera(viewer);
      if (follow && camera?.followed === follow) camera.follow(null);
      follow = null;
    },
    destroy() {
      this.stop();
      off?.();
    },
  };
}
