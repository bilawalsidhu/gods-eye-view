/**
 * @module render/baseTilesets
 * @description Tilesets the application draws as its base outside the
 * renderer's globe port, marked so the port drapes imagery on them while
 * they are shown. Cesium-free: code that loads its own base, or hands
 * a layer one (`recentImagery.attachTileset`), marks it here without
 * reaching the renderer; the renderer's globe port reads the marks.
 */

const marked = new WeakSet();

/**
 * Mark a tileset as a base the application draws outside the port, so
 * imagery drapes on it while it is shown. The port's own photoreal tileset
 * needs no mark.
 * @param {object} tileset The renderer's tileset object.
 */
export function markBaseTileset(tileset) {
  if (tileset && typeof tileset === 'object') marked.add(tileset);
}

/** Whether `tileset` was marked as a base (`markBaseTileset`). */
export const isBaseTileset = (tileset) =>
  Boolean(tileset && typeof tileset === 'object' && marked.has(tileset));
