/**
 * Shared pick-ownership registry for layers that install their own
 * ScreenSpaceEventHandler click handlers.
 *
 * Problem solved: each entity layer (commercial flights, military flights)
 * receives every LEFT_CLICK. When the user clicks a military aircraft while
 * a commercial flight is tracked, the commercial handler used to classify
 * the pick as "empty space" and clear tracking (with a camera flight) at the
 * same moment the military handler started tracking — two competing camera
 * commands. Layers now register a predicate so siblings can recognize picks
 * that belong to someone else and leave them alone.
 */

import { sceneServicesFor } from './sceneServices.js';
import { isSurfacePick } from './scenePick.js';

/**
 * Resolves a scene.pick() result to a String pick id for the ownership scan.
 *
 * Layers use heterogeneous pick ids: flights/military/bikeshare/CCTV use
 * strings, satellites use numeric NORAD catalog ids, live AIS vessels attach
 * the vessel record OBJECT (identity = its `mmsi`), and entity picks surface
 * the Cesium Entity (identity = its string `id`). Everything is coerced to a
 * String so predicates match against one canonical form.
 *
 * @param {object|null|undefined} picked - Result of `scene.pick()`.
 * @returns {string|null} Canonical pick id, or null when the pick carries none.
 */
export function resolvePickId(picked) {
  if (!picked) return null;
  const unwrap = (id) => {
    if (id === null || id === undefined) return undefined;
    if (typeof id === 'object') {
      // AIS vessel record (id object with .mmsi) or Cesium Entity (.id string)
      if (typeof id.mmsi === 'string' || typeof id.mmsi === 'number')
        return id.mmsi;
      if (typeof id.id === 'string' || typeof id.id === 'number') return id.id;
      return undefined;
    }
    return id;
  };
  let id = unwrap(picked.id);
  if (id === undefined) id = unwrap(picked.primitive?.id);
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** Own the pick predicates for one scene. */
export function createPickRegistry() {
  const _owners = new Map();
  let destroyed = false;

  /**
   * Registers a pick-ownership predicate for a layer.
   * @param {string} layerId - Owning layer id (e.g. 'flights').
   * @param {(pickedId: string) => boolean} predicate - Returns true when the
   *   picked primitive/entity id belongs to this layer.
   * @returns {void}
   */
  function registerPickOwner(layerId, predicate) {
    if (destroyed || !layerId || typeof predicate !== 'function') return;
    _owners.set(layerId, predicate);
  }

  /**
   * Removes a layer's ownership predicate (call on disable/destroy).
   * @param {string} layerId - Owning layer id.
   * @returns {void}
   */
  function unregisterPickOwner(layerId) {
    _owners.delete(layerId);
  }

  /**
   * The registered layer that owns a picked id, or null.
   * @param {string} pickedId - Canonical pick id from {@link resolvePickId}.
   * @returns {string|null} Owning layer id.
   */
  function findPickOwner(pickedId) {
    if (!pickedId) return null;
    for (const [ownerId, predicate] of _owners) {
      try {
        if (predicate(pickedId)) return ownerId;
      } catch {
        // a broken predicate must never break picking
      }
    }
    return null;
  }

  /**
   * True when some OTHER registered layer owns the picked id.
   * @param {string} layerId - The asking layer's id (excluded from the scan).
   * @param {string} pickedId - Picked primitive/entity id.
   * @returns {boolean}
   */
  function isOwnedByOtherLayer(layerId, pickedId) {
    if (!pickedId) return false;
    for (const [ownerId, predicate] of _owners) {
      if (ownerId === layerId) continue;
      try {
        if (predicate(pickedId)) return true;
      } catch {
        // a broken predicate must never break click handling
      }
    }
    return false;
  }

  /**
   * Resolve a moving-contact click without letting map tiles hide a nearby touch
   * target. Exact picks always win; only a coarse primary pointer may expand a
   * surface miss. Every consumer uses the same ordered, bounded scene hits, so sibling layers
   * do not each choose their own contact under one tap.
   * Unowned non-surface objects remain barriers, not permission to pick through.
   *
   * @param {object} scene Cesium scene with pick and optional drillPick.
   * @param {{x: number, y: number}} position Screen position in CSS pixels.
   * @returns {object|null|undefined} Original pick or the first registered touch hit.
   */
  function pickContact(scene, position) {
    return nearbyContact(
      scene.pick(position),
      position,
      scene.drillPick?.bind(scene),
    );
  }

  function nearbyContact(picked, position, drillPick) {
    if (
      !globalThis.matchMedia?.('(pointer: coarse)').matches ||
      findPickOwner(resolvePickId(picked)) ||
      !isSurfacePick(picked) ||
      typeof drillPick !== 'function'
    )
      return picked;
    let hits;
    try {
      hits = drillPick(position, 8, 14, 14) || [];
    } catch {
      return picked;
    }
    for (const hit of hits.slice(0, 8)) {
      if (findPickOwner(resolvePickId(hit))) return hit;
      if (!isSurfacePick(hit)) break;
    }
    return picked;
  }

  registerPickOwner('trails', (id) => String(id).startsWith('gev-trail:'));

  return {
    resolvePickId,
    owners: () => [..._owners.keys()],
    registerPickOwner,
    unregisterPickOwner,
    findPickOwner,
    isOwnedByOtherLayer,
    pickContact,
    nearbyContact,
    destroy() {
      destroyed = true;
      _owners.clear();
    },
  };
}

/** Pick ownership of the scene attached to this engine. */
export function pickRegistryFor(engine) {
  return sceneServicesFor(engine)?.picking ?? null;
}

export function registerPickOwner(layerId, predicate, engine) {
  return pickRegistryFor(engine)?.registerPickOwner(layerId, predicate);
}

export function unregisterPickOwner(layerId, engine) {
  return pickRegistryFor(engine)?.unregisterPickOwner(layerId);
}

export function findPickOwner(pickedId, engine) {
  return pickRegistryFor(engine)?.findPickOwner(pickedId) ?? null;
}

export function isOwnedByOtherLayer(layerId, pickedId, engine) {
  return (
    pickRegistryFor(engine)?.isOwnedByOtherLayer(layerId, pickedId) ?? false
  );
}

export function pickContact(scene, position, engine) {
  return pickRegistryFor(engine)?.pickContact(scene, position) ?? null;
}

export function nearbyContact(picked, position, drillPick, engine) {
  return (
    pickRegistryFor(engine)?.nearbyContact(picked, position, drillPick) ??
    picked
  );
}
