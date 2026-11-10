import { Cesium3DTileset } from 'cesium';
import { localTilesetPath } from '../../maps/qaTileset.js';

/** The QA source uses the controller's normal tileset ownership path. */
export function createQaTileset(url, { signal } = {}) {
  signal?.throwIfAborted();
  return Cesium3DTileset.fromUrl(localTilesetPath(url));
}
