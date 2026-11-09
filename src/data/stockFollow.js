/**
 * @module data/stockFollow
 * @description A double-click on a layer's drawn item follows it, as the
 * default renderer's own double-click followed the entities layers drew
 * before they drew through the draw port: an item with a position is
 * followed, framed as that renderer framed an entity it started following;
 * one without (a line) is zoomed to at once instead. It runs only while the
 * renderer's own double-click follow is on (a tool can hold it off).
 */
import { followOffsetFitting } from '../geo/frames.js';
import { findCamera, findQuery } from '../render/rendererOf.js';

/**
 * Where the camera frames a part it starts following: `followOffsetFitting`
 * with the camera port's field of view and zoom limits.
 * @param {{center: {x: number, y: number, z: number}, radius: number}} sphere
 * @param {{x: number, y: number, z: number}} at
 * @param {object} camera The camera port.
 */
export function followViewFrom(sphere, at, camera) {
  const pose = camera.pose?.();
  const { minDistance, maxDistance } = camera.controls ?? {};
  return followOffsetFitting(sphere, at, {
    fovy: pose?.fovy,
    aspectRatio: pose?.aspectRatio,
    minDistance,
    maxDistance,
  });
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
