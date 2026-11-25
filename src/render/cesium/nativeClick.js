/**
 * @module render/cesium/nativeClick
 * @description Cesium's own picks of a click, for what the renderer's picks
 * do not name (`rendererOf.js` `nativeClickOf`): things drawn outside the
 * draw port, and code still bound to Cesium's pick objects. Each pick is
 * made at most once per click, and a hit on the follow's helper entity is a
 * hit on its target (`pickThroughFollowHelper`).
 *
 * Also the raw forms of the shared pick-id and contact rules
 * (`src/data/pickRegistry.js`, which reads the contract's `Hit`), for code
 * that still holds a Cesium pick.
 */
import * as Cesium from 'cesium';
import { findPickOwner } from '../../data/pickRegistry.js';
import { isSurfacePick } from '../../data/scenePick.js';
import { provideNativeClick } from '../rendererOf.js';
import { drawHitOf } from './drawHit.js';
import { pickThroughFollowHelper } from './follow.js';
import { recentPick } from './pickMemo.js';
import { viewerBehind } from './viewers.js';

/** A drill is run at least this deep and sliced, so callers asking for
 *  different depths on one click share one pass. */
const DRILL_DEPTH = 16;

/**
 * A Cesium pick's canonical pick id: its id, or its primitive's, as a
 * String (satellites' numeric NORAD ids, an entity's own `id`); null when it
 * carries none.
 * @param {object|null|undefined} picked What `scene.pick` gave.
 * @returns {string|null}
 */
export function nativePickId(picked) {
  if (!picked) return null;
  const unwrap = (id) => {
    if (id === null || id === undefined) return undefined;
    if (typeof id === 'object') {
      // A Cesium Entity (.id string), or a draw-set item's pick id.
      if (typeof id.id === 'string' || typeof id.id === 'number') return id.id;
      return undefined;
    }
    return id;
  };
  let id = unwrap(picked.id);
  if (id === undefined) id = unwrap(picked.primitive?.id);
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/**
 * `pickContact` (`src/data/pickRegistry.js`) over Cesium's own picks: on a
 * coarse pointer, the first registered contact under a surface pick.
 * @param {object} scene
 * @param {{x: number, y: number}} position
 * @param {{picked?: object|null, drill?: (limit: number, width: number, height: number) => object[]}} [options]
 * @returns {object|null|undefined}
 */
export function nativePickContact(scene, position, options = {}) {
  const picked = 'picked' in options ? options.picked : scene.pick(position);
  if (
    !globalThis.matchMedia?.('(pointer: coarse)').matches ||
    findPickOwner(nativePickId(picked)) ||
    !isSurfacePick(picked) ||
    typeof scene.drillPick !== 'function'
  )
    return picked;
  let hits;
  try {
    hits =
      (options.drill
        ? options.drill(8, 14, 14)
        : scene.drillPick(position, 8, 14, 14)) || [];
  } catch {
    return picked;
  }
  for (const hit of hits.slice(0, 8)) {
    if (findPickOwner(nativePickId(hit))) return hit;
    if (!isSurfacePick(hit)) break;
  }
  return picked;
}

/**
 * What is on top as Cesium sees it, where the renderer's pick names
 * nothing: a draw-set item the renderer's sets do not hold (one drawn by a
 * draw port a renderer bound since superseded) as its hit, anything else
 * but the map by its id; null for the map or nothing.
 */
const foreignOf = (picked) =>
  isSurfacePick(picked)
    ? null
    : (drawHitOf(picked) ?? { id: nativePickId(picked) });

/** A Cesium pick as the contract's `Hit`, a foreign one with no set. */
const hitOf = (picked) =>
  drawHitOf(picked) ??
  (isSurfacePick(picked)
    ? { set: '', id: '', surface: true }
    : { set: '', id: nativePickId(picked), surface: false });

/**
 * A click's Cesium picks at a pick-buffer position.
 * @param {object} scene
 * @param {{x: number, y: number}} at
 * @returns {import('../rendererOf.js').NativeClick}
 */
export function createNativeClick(scene, at) {
  const position = new Cesium.Cartesian2(at.x, at.y);
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  /** @type {Map<string, {limit: number, hits: object[]}>} */
  const drills = new Map();
  // The query port's pick of this pixel, when it just made one: the click
  // reads the renderer's pick first, so its own Cesium pick costs no pass.
  const picked = (width, height) => {
    const recent = recentPick(scene, at.x, at.y, width ?? 3, height ?? 3);
    return recent
      ? recent.picked
      : width === undefined
        ? scene.pick(position)
        : scene.pick(position, width, height);
  };
  const native = {
    /** `scene.pick` at the click. */
    get pick() {
      return once('pick', () => pickThroughFollowHelper(picked()));
    },
    /** `scene.pick` with a wider window. */
    pickWindow(width, height) {
      return once(`window:${width}x${height}`, () =>
        pickThroughFollowHelper(picked(width, height)),
      );
    },
    /** `scene.drillPick`, at most `limit` hits. */
    drill(limit = DRILL_DEPTH, width, height) {
      const key = `${width}x${height}`;
      const done = drills.get(key);
      // A pass that came back short already holds every hit there is.
      if (done && (limit <= done.limit || done.hits.length < done.limit))
        return done.hits.slice(0, limit);
      if (typeof scene.drillPick !== 'function') return [];
      // Only the default window is shared between callers; round that one up.
      const depth =
        width === undefined && height === undefined
          ? Math.max(limit, DRILL_DEPTH)
          : limit;
      const hits = (scene.drillPick(position, depth, width, height) || [])
        .map(pickThroughFollowHelper)
        .filter(Boolean);
      drills.set(key, { limit: depth, hits });
      return hits.slice(0, limit);
    },
  };
  return {
    native,
    drillHits: (limit, width, height) =>
      native.drill(limit, width, height).map(hitOf),
    foreign: (width, height) =>
      foreignOf(
        width === undefined && height === undefined
          ? native.pick
          : native.pickWindow(width, height),
      ),
  };
}

// The viewer behind the scene object, bound or not, by shape: an unbound one
// may come from another copy of Cesium.
provideNativeClick((host, at) => {
  const scene = viewerBehind(host)?.scene;
  if (typeof scene?.pick !== 'function') return null;
  return createNativeClick(scene, at);
});
