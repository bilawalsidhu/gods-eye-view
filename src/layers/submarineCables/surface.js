import * as Cesium from 'cesium';
import { CABLE_GLOBE_STACK_IDS } from './policy.js';

/**
 * Ground-line classification for one map stack. The photoreal stack renders
 * Google 3D tiles with the Cesium globe HIDDEN, so cable ground lines only
 * need the 3D-tile classification pass there; every other known stack (the
 * bing stacks and osm) renders imagery on the shown globe, so only the
 * terrain pass applies.
 * Classifying against just the active surface halves the
 * GroundPolylinePrimitive's emitted command sets. BOTH is the safe fallback
 * for an unknown stack — it renders on every surface, exactly the shipped
 * pre-optimization behavior.
 * @param {string|null|undefined} activeId MapStackController stack id.
 * @returns {Cesium.ClassificationType}
 */

export function cableClassificationTypeForStack(activeId) {
  if (activeId === 'photoreal') return Cesium.ClassificationType.CESIUM_3D_TILE;
  if (CABLE_GLOBE_STACK_IDS.has(activeId))
    return Cesium.ClassificationType.TERRAIN;
  return Cesium.ClassificationType.BOTH;
}

/**
 * Derive the active surface from live scene state. The boot-time
 * `setStack(..., { silent: true })` fires no 'gev:map-stack-changed' event,
 * so the initial classification reads the scene the way the height-datum
 * listeners do: the photoreal regime is exactly "globe hidden".
 * @param {Cesium.Scene|null|undefined} scene
 * @returns {Cesium.ClassificationType}
 */

export function cableClassificationTypeForScene(scene) {
  if (!scene?.globe) return Cesium.ClassificationType.BOTH;
  return scene.globe.show === false
    ? Cesium.ClassificationType.CESIUM_3D_TILE
    : Cesium.ClassificationType.TERRAIN;
}
