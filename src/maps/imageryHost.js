/**
 * Where draped imagery can go on the current map stack. A globe stack drapes
 * on `viewer.imageryLayers`; a 3D-tiles stack hides the globe, and Cesium
 * 1.138 drapes imagery onto the tileset's own `imageryLayers` instead. When
 * neither exists there is nowhere to drape and the caller says so.
 */

/** Guidance shown when the active map stack cannot host draped imagery. */
export const NO_IMAGERY_HOST = 'Hidden by this map source · choose a globe map';

/**
 * Resolve the imagery layer collection for the active map stack.
 * @param {{ viewer?: object, tileset?: object }} scene
 * @returns {{ collection: object | null, kind: 'globe' | 'tileset' | 'none' }}
 */
export function resolveImageryHost({ viewer, tileset } = {}) {
  if (viewer?.scene?.globe?.show === true && viewer.imageryLayers) {
    return { collection: viewer.imageryLayers, kind: 'globe' };
  }
  if (tileset?.imageryLayers && !tileset.isDestroyed?.()) {
    return { collection: tileset.imageryLayers, kind: 'tileset' };
  }
  return { collection: null, kind: 'none' };
}
