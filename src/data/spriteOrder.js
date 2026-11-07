/** Bottom-to-top order for near-plane-clamped contact sprite collections. */
export const SPRITE_LAYER_ORDER = Object.freeze([
  'cctv',
  'firms',
  'bikeshare',
  'transit',
  'transit-motion',
  'directions',
  'ais',
  'military',
  'flights',
]);

/** @type {Map<string, Object>} */
const _collections = new Map();

/**
 * Register the current primitive collection for a sprite layer.
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} collection - Cesium billboard/point primitive collection.
 * @returns {void}
 */
export function registerSpriteCollection(layerId, collection) {
  if (!layerId || !collection) return;
  _collections.set(layerId, collection);
}

/**
 * Register a renderer draw set for a sprite layer, by its set id. The
 * default renderer names each set's host primitive with `drawSetId`; the
 * restorer raises the host it finds under that name, whichever host the
 * set draws with now.
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {string} setId - The draw set's id.
 * @returns {object} The registration, for `unregisterSpriteCollection`'s guard.
 */
export function registerSpriteSet(layerId, setId) {
  const entry = Object.freeze({ drawSetId: setId });
  if (layerId && typeof setId === 'string') _collections.set(layerId, entry);
  return entry;
}

/**
 * The primitive `entry` names: itself, or a draw set's host found by its id.
 * The topmost match wins, so a host still retiring below its replacement is
 * skipped.
 */
function resolveSprite(primitives, entry) {
  if (typeof entry?.drawSetId !== 'string') return entry;
  for (let i = (primitives.length ?? 0) - 1; i >= 0; i--) {
    const primitive = primitives.get(i);
    if (primitive?.drawSetId === entry.drawSetId) return primitive;
  }
  return null;
}

/**
 * Remove a registered collection (primarily useful to lifecycle tests).
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} [collection] - Optional identity guard against stale teardown.
 * @returns {void}
 */
export function unregisterSpriteCollection(layerId, collection) {
  if (collection && _collections.get(layerId) !== collection) return;
  _collections.delete(layerId);
}

/**
 * Reassert deterministic sprite stacking after any layer enable/init.
 * Cesium's stable translucent sort otherwise preserves first-enable primitive
 * order. Raising bottom-to-top makes flights the final/top collection.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @returns {void}
 */
export function restoreSpriteOrder(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return;
  const scene = viewer.scene;
  const primitives = scene?.primitives;
  if (!primitives || scene.isDestroyed?.() || primitives.isDestroyed?.())
    return;

  for (const layerId of SPRITE_LAYER_ORDER) {
    const collection = resolveSprite(primitives, _collections.get(layerId));
    if (!collection || collection.isDestroyed?.()) continue;
    if (primitives.contains?.(collection) === false) continue;
    primitives.raiseToTop(collection);
  }
}

/**
 * Explicit layer-enable wiring seam. Production callers use the shared
 * restorer by default; tests inject a spy to pin each enable path without
 * constructing a WebGL viewer.
 * @param {string} layerId - Sprite layer whose enable path is restoring order.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @param {(viewer: Object) => void} [restore=restoreSpriteOrder] - Test seam.
 * @returns {void}
 */
export function restoreSpriteOrderOnEnable(
  layerId,
  viewer,
  restore = restoreSpriteOrder,
) {
  if (!SPRITE_LAYER_ORDER.includes(layerId) || typeof restore !== 'function')
    return;
  restore(viewer);
}
