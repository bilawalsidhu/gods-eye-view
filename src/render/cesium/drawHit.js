/**
 * @module render/cesium/drawHit
 * @description A Cesium pick of a draw-set item, as the contract's `Hit`.
 * No imports, so the click dispatcher can use it without the draw port.
 */
/**
 * A Cesium pick as the contract's `Hit` (`query.d.ts`), when what it picked
 * is a draw-set item (its pick id is `{set, id, meta}`); else
 * null. For code that reads a pick Cesium already made (the click
 * dispatcher's); `query.pick` makes its own, and also leaves out items of
 * hidden or unpickable sets. It does not check that the set or item is
 * still drawn (a ground swap can pick a retiring primitive), so a caller
 * matches the hit against its own current sets and item ids.
 * @param {object|null|undefined} picked
 */
export function drawHitOf(picked) {
  const id = picked?.id;
  if (!id || typeof id.set !== 'string' || typeof id.id !== 'string')
    return null;
  return {
    set: id.set,
    id: id.id,
    ...(id.meta === undefined ? {} : { meta: id.meta }),
    surface: false,
  };
}
