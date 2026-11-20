/**
 * Default-deny for positions the text tools must not hand to the hosted model
 * as coordinates. It does not hide the thing: the map still draws it, so a
 * screenshot, the pointer's screen position or a cursor beside the marker can
 * still locate it.
 *
 * A layer whose positions can be untrustworthy (Local AIS marks fixes that are
 * unvalidated or approximate) declares `isPositionTrusted(id)` on its module.
 * Only an explicit `true` sends a position; a missing record, a missing
 * module, a thrown error or any other value withholds it. Layers listed in
 * GATED_LAYERS are withheld even when their module cannot be reached.
 */
const GATED_LAYERS = new Set(['local-ais']);

/**
 * @param {object|null} dataManager Layer lifecycle.
 * @param {string|null} layerId Layer that owns the picked or named thing.
 * @param {string|null} id The thing's id in that layer.
 * @returns {boolean} True when the position of this thing must be withheld.
 */
export function positionWithheld(dataManager, layerId, id) {
  if (!layerId) return false;
  let check = null;
  try {
    check = dataManager?.layers?.get?.(layerId)?.module?.isPositionTrusted;
  } catch {
    check = null;
  }
  if (typeof check !== 'function') return GATED_LAYERS.has(layerId);
  try {
    return (
      check.call(dataManager.layers.get(layerId).module, String(id ?? '')) !==
      true
    );
  } catch {
    return true;
  }
}
