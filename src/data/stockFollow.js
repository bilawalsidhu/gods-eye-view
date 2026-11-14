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
import { entityFollowTarget } from './followed.js';
import { positionToEcef } from '../geo/ellipsoid.js';
import { sphereFromPoints } from '../geo/sphere.js';

/** A line's or shape's positions as ECEF points. */
function pointsOf(positions) {
  if (!positions) return [];
  if (ArrayBuffer.isView(positions)) {
    const out = [];
    for (let i = 0; i + 2 < positions.length; i += 3)
      out.push({ x: positions[i], y: positions[i + 1], z: positions[i + 2] });
    return out;
  }
  return Array.from(positions, positionToEcef);
}

/**
 * What a double-click on a drawn item does, as the default renderer did
 * for the entity a layer drew it as before: a point, an icon or a disc
 * (an entity with a position) is followed, framed to fit the disc; a line
 * or another shape (an entity without one) is zoomed to. For a layer's
 * `targetFor`, given the hit's set id and the item drawn there.
 * @param {string} set The hit's set id.
 * @param {object|null|undefined} item The draw item (draw.d.ts) the hit names.
 */
export function drawnItemTarget(set, item) {
  if (!item) return null;
  const key = `${set}:${item.id}`;
  if (item.pos) {
    const at = positionToEcef(item.pos);
    return { key, position: () => ({ ...at }) };
  }
  const geometry = item.geometry;
  if (geometry?.kind === 'ellipse') {
    const at = positionToEcef(geometry.center);
    const radius = Math.max(geometry.semiMajor, geometry.semiMinor);
    return {
      key,
      position: () => ({ ...at }),
      sphere: { center: at, radius: Number.isFinite(radius) ? radius : 0 },
    };
  }
  let points = pointsOf(item.positions);
  if (geometry?.kind === 'polygon') points = pointsOf(geometry.rings?.[0]);
  else if (geometry?.kind === 'wall') points = pointsOf(geometry.positions);
  else if (geometry?.kind === 'rectangle') {
    const { west, south, east, north } = geometry.rect;
    points = pointsOf([
      { lon: west, lat: south },
      { lon: east, lat: south },
      { lon: east, lat: north },
      { lon: west, lat: north },
    ]);
  }
  return points.length ? { zoomTo: sphereFromPoints(points) } : null;
}

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
 *     sphere?: {center: object, radius: number}, entity?: object}
 *   | {zoomTo: {center: object, radius: number}}
 *   | null)} options.targetFor What a hit on one of the layer's items is
 *   followed by (`key`, its live `position`, the bounds it is framed by,
 *   radius 0 by default, and the holder whose entity record shows it, as
 *   `entityFollowTarget` reads one), or zoomed to (`zoomTo`); null for
 *   anything else.
 * @returns {{readonly following: object|null, retain(drawn: (key: string) => boolean): void,
 *   stop(): void, destroy(): void}}
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
        const fields = {
          key: found.key,
          position: found.position,
          frame: 'enu',
          viewFrom: followViewFrom(
            found.sphere ?? { center: at, radius: 0 },
            at,
            camera,
          ),
        };
        const target = found.entity
          ? entityFollowTarget(found.entity, fields)
          : fields;
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
    /**
     * Stop a follow this started of something no longer drawn, as removing
     * an entity ended the default renderer's follow of it.
     * @param {(key: string) => boolean} drawn Whether the item keyed so is.
     */
    retain(drawn) {
      const key = this.following?.key;
      if (key && !drawn(key)) this.stop();
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
