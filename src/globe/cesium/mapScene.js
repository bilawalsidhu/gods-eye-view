import * as Cesium from 'cesium';
import { createMapCredits } from '../../maps/credits.js';

/**
 * The scene changes a map source makes on a Cesium viewer: the base imagery
 * layer, which 3D tileset shows, the globe, and the source's static credit.
 * Shared by MapSourceController and the Cesium globe engine's `maps`, so
 * both apply sources the same way. Creating it touches nothing.
 * @param {Cesium.Viewer} viewer
 * @param {{
 *   createImageryLayer?: (provider: object) => object,
 *   credits: import('../contract.js').GlobeEngine['credits'],
 * }} options `credits`: the globe engine's credits.
 */
export function createMapScene(
  viewer,
  {
    createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
    credits: engineCredits,
  } = {},
) {
  const credits = createMapCredits(engineCredits);
  let layer = null;
  let provider = null;
  const scene = {
    /** The provider of the live base layer, or null. */
    get baseProvider() {
      return provider;
    },
    /**
     * Show `next` as the bottom imagery layer. The live layer (and its loaded
     * tiles) stays when its provider is unchanged: rebuilding it exposes the
     * bare globe while imagery loads again. Returns whether it was replaced.
     */
    showBaseImagery(next) {
      if (layer && provider === next) return false;
      scene.removeBaseImagery();
      layer = createImageryLayer(next);
      provider = next;
      viewer.imageryLayers.add(layer, 0);
      return true;
    },
    removeBaseImagery() {
      if (layer) viewer.imageryLayers.remove(layer, true);
      layer = null;
      provider = null;
    },
    /** Show `active` (or none) among `tilesets`. */
    showTileset(active, tilesets) {
      for (const tileset of tilesets) tileset.show = tileset === active;
    },
    showGlobe(visible) {
      viewer.scene.globe.show = visible;
    },
    showCredit(html) {
      credits.show(html || null);
    },
    destroy() {
      scene.removeBaseImagery();
      credits.destroy();
    },
  };
  return scene;
}
