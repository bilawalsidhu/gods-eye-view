// GlobeSurface on a Cesium scene: the rendered-surface queries that
// services/groundSnap and services/meshFloorSampler make.

import { firstVisibleTileset } from '../../services/groundSnap.js';
import { normalizeSurfaceOptions } from '../surfaceDetail.js';
import { toGeo3 } from './convert.js';

const finite = (value) => (Number.isFinite(value) ? value : undefined);

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ surface: import('../contract.js').GlobeSurface, destroy: () => void }}
 */
export function createCesiumSurface(viewer) {
  const { scene } = viewer;

  const sampleHeight = (cartographic, exclude) => {
    if (!scene.sampleHeightSupported) return undefined;
    try {
      // Throws when unsupported (no depth textures); that is a miss.
      return finite(scene.sampleHeight(cartographic, exclude));
    } catch {
      return undefined;
    }
  };
  const terrainHeight = (cartographic) =>
    scene.globe ? finite(scene.globe.getHeight(cartographic)) : undefined;

  const surface = {
    sampleHeight,
    // Cesium samples the tiles it has loaded and does not say which tile
    // answered.
    sampleHeightDetailed(cartographic, options) {
      const { exclude } = normalizeSurfaceOptions(options);
      const height = sampleHeight(cartographic, exclude);
      if (height !== undefined) return { height, source: 'tiles' };
      const terrain = terrainHeight(cartographic);
      return terrain === undefined
        ? undefined
        : { height: terrain, source: 'terrain' };
    },
    get supported() {
      return Boolean(scene.sampleHeightSupported);
    },
    terrainHeight,
    get terrainHeightSupported() {
      return Boolean(scene.globe);
    },
    clampToHeight(position, exclude) {
      if (!scene.clampToHeightSupported) return undefined;
      try {
        return toGeo3(scene.clampToHeight(position, exclude));
      } catch {
        return undefined;
      }
    },
    get clampToHeightSupported() {
      return Boolean(scene.clampToHeightSupported);
    },
    tilesLoaded() {
      const tileset = firstVisibleTileset(scene.primitives);
      if (tileset) return tileset.tilesLoaded === true;
      return scene.globe?.show ? scene.globe.tilesLoaded === true : true;
    },
  };
  return { surface, destroy() {} };
}
