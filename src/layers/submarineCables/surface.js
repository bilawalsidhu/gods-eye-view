import * as Cesium from 'cesium';
import {
  CABLE_GLOBE_STACK_IDS,
  MARKER_COLLECTION_EXPECTATIONS,
} from './policy.js';

/**
 * Ground-line classification for one map stack. The photoreal stack renders
 * Google 3D tiles with the Cesium globe HIDDEN, so cable ground lines only
 * need the 3D-tile classification pass there; every other known stack (the
 * bing stacks and osm) renders imagery on the shown globe, so only the
 * terrain pass applies.
 * Classifying against just the active surface halves the batched
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

/**
 * Validate one data source's marker collections WITHOUT mutating anything.
 * Splitting validation from mutation is what makes the fallback honest: a
 * shape failure on the SECOND collection (or the second data source) must
 * not leave the first one already forced to TRANSLUCENT.
 * @param {Cesium.DataSource|null|undefined} dataSource
 * @returns {{ready:object[],pending:number,invariantFailed:boolean}}
 */

export function probeTranslucentMarkerBlend(dataSource) {
  const cluster = dataSource?.clustering;
  if (!cluster) return { ready: [], pending: 0, invariantFailed: true };
  const ready = [];
  let pending = 0;
  let invariantFailed = false;
  for (const { key, type } of MARKER_COLLECTION_EXPECTATIONS) {
    if (!(key in cluster)) {
      invariantFailed = true;
      continue;
    }
    const collection = cluster[key];
    if (collection === undefined || collection === null) {
      pending++;
      continue;
    }
    if (!(collection instanceof type) || !('blendOption' in collection)) {
      invariantFailed = true;
      continue;
    }
    ready.push(collection);
  }
  // Any failure discards every collected target: nothing is mutated at all.
  if (invariantFailed) return { ready: [], pending: 0, invariantFailed: true };
  return { ready, pending, invariantFailed: false };
}

/**
 * Commit a clean probe. Only ever called once every probe in the batch has
 * passed, so this cannot land a partial application.
 * @param {{ready:object[],pending:number}} probe
 * @returns {{applied:number,pending:number,invariantFailed:boolean}}
 */

export function commitTranslucentMarkerBlend(probe) {
  for (const collection of probe.ready) {
    if (collection.blendOption !== Cesium.BlendOption.TRANSLUCENT) {
      collection.blendOption = Cesium.BlendOption.TRANSLUCENT;
    }
  }
  return {
    applied: probe.ready.length,
    pending: probe.pending,
    invariantFailed: false,
  };
}

/**
 * Force one translucent draw pass for a data source's marker collections.
 * The default `OPAQUE_AND_TRANSLUCENT` blend emits two draw commands per
 * collection, and every cable marker is translucent (alpha < 1), so the
 * opaque pass is pure overhead across 1,917 landing billboards + 2,629
 * reference points. Cesium has no public accessor for the entity-backed
 * collections, so this reaches through EntityCluster's private fields under
 * a SHAPE INVARIANT the caller must honor loudly: the constructor
 * pre-assigns `_billboardCollection`/`_pointCollection` (= undefined until a
 * visualizer lazily creates them), so a missing PROPERTY means Cesium's
 * shape changed — report `invariantFailed` and never touch anything —
 * while a present-but-undefined value only means "not created yet"
 * (`pending`). Wrong instance types also fail the invariant. The cables
 * sources never enable clustering, so created collections persist.
 * VALIDATE-ALL-THEN-MUTATE-ALL: every field/type check runs before the first
 * assignment, so a failure anywhere leaves BOTH collections on Cesium's
 * default blend — the fallback this helper promises.
 * @param {Cesium.DataSource|null|undefined} dataSource
 * @returns {{applied:number,pending:number,invariantFailed:boolean}}
 */

export function applyTranslucentMarkerBlend(dataSource) {
  const probe = probeTranslucentMarkerBlend(dataSource);
  if (probe.invariantFailed)
    return { applied: 0, pending: 0, invariantFailed: true };
  return commitTranslucentMarkerBlend(probe);
}
