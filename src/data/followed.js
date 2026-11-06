/**
 * @module data/followed
 * @description What the camera follows, for the Core code that reads it.
 *
 * A layer follows through the camera port with a FollowTarget that also
 * carries what Core shows about it (key, display position, sprite, label).
 * Until every layer does, a layer may still track an entity of its own
 * through Cesium's `trackedEntity`; that entity is seen here through the
 * same fields, read from its entity record. Readers ask this module, never
 * `trackedEntity`, so they work either way.
 */
import { findCamera } from '../render/rendererOf.js';
import { readEntityRecord } from './entityRecords.js';

/**
 * @typedef {object} Followed
 * @property {string|null} key Stable id, e.g. `'flights:a1b2c3'`.
 * @property {string} [name] Display name, when the target has one.
 * @property {() => object|null} [displayPosition] Where the follow camera
 *   frames the target this frame (the layer's display cache).
 * @property {() => object|null} [visualPosition] Where the target is drawn.
 * @property {object} [sprite] Size of the drawn billboard.
 * @property {object} [labelModel]
 * @property {string} [selectionOrigin]
 * @property {object} [entity] The tracked entity, for a layer that still
 *   tracks one itself.
 */

/** @type {WeakMap<object, Followed>} */
const entityViews = new WeakMap();

function entityView(entity) {
  let view = entityViews.get(entity);
  if (!view) {
    const id = String(entity.id ?? '').trim();
    view = {
      entity,
      get key() {
        const explicit = String(readEntityRecord(entity)?.trackedId ?? '');
        return explicit.trim() || (id ? `entity:${id}` : null);
      },
      get name() {
        return entity.name;
      },
      get displayPosition() {
        return readEntityRecord(entity)?.displayPosition;
      },
      get visualPosition() {
        return readEntityRecord(entity)?.visualPosition;
      },
      get sprite() {
        return readEntityRecord(entity)?.sprite;
      },
      get labelModel() {
        return readEntityRecord(entity)?.labelModel;
      },
      get selectionOrigin() {
        return readEntityRecord(entity)?.selectionOrigin;
      },
    };
    entityViews.set(entity, view);
  }
  return view;
}

/**
 * What `viewer`'s camera follows, or null. The same object comes back for
 * as long as the same thing is followed.
 * @param {object|null|undefined} viewer
 * @returns {Followed|null}
 */
export function followedOf(viewer) {
  if (!viewer) return null;
  const target = findCamera(viewer)?.followed;
  if (target) return target;
  const entity = viewer.trackedEntity;
  return entity ? entityView(entity) : null;
}

/** Whether `viewer`'s camera follows anything. */
export function isFollowing(viewer) {
  return followedOf(viewer) !== null;
}

/**
 * Run `cb` whenever what `viewer`'s camera follows changes.
 * @param {object} viewer
 * @param {(followed: Followed|null) => void} cb
 * @returns {() => void} Off.
 */
export function onFollowChanged(viewer, cb) {
  let last = followedOf(viewer);
  let port = null;
  let offPort = null;
  // The port is looked up again on every change: a renderer bound after
  // this subscribed replaces the one it listened to. A Cesium port's follow
  // also sets `trackedEntity`, so the change still arrives through it.
  const listenToPort = () => {
    const current = findCamera(viewer);
    if (current === port) return;
    offPort?.();
    port = current;
    offPort = port?.on('followChanged', check) ?? null;
  };
  function check() {
    listenToPort();
    const now = followedOf(viewer);
    if (now === last) return;
    last = now;
    cb(now);
  }
  listenToPort();
  const offTracking = viewer.trackedEntityChanged?.addEventListener(check);
  return () => {
    offPort?.();
    offPort = null;
    offTracking?.();
  };
}

/** Stop the camera following anything, a layer's own tracking included. */
export function stopFollowing(viewer) {
  if (!viewer) return;
  const camera = findCamera(viewer);
  if (camera?.followed) camera.follow(null);
  else if (viewer.trackedEntity) viewer.trackedEntity = undefined;
}
