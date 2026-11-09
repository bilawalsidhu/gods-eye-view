/**
 * @module render/cesium/mapEngine
 * @description The Cesium map engine (`src/maps/engine.js`): the providers
 * the map stacks' imagery and terrain come from (`mapImagery.js`,
 * `mapTerrain.js`), and the viewer operations the map source controller
 * switches stacks with. Provided as this module loads.
 */
import * as Cesium from 'cesium';
import { provideMapEngine } from '../../maps/engine.js';
import {
  createEsriImagery,
  createIonImagery,
  createOsmImagery,
} from './mapImagery.js';
import { createKeylessTerrain, createWorldTerrain } from './mapTerrain.js';

export const cesiumMapEngine = Object.freeze({
  imagery: Object.freeze({
    osm: createOsmImagery,
    esri: createEsriImagery,
    /** `style`: the ion world imagery asset (`MAP_STACKS`' `style`). */
    ion: createIonImagery,
  }),
  terrain: Object.freeze({
    world: createWorldTerrain,
    keyless: createKeylessTerrain,
  }),
  /** The layer a globe stack's imagery provider draws through. */
  createImageryLayer: (provider) => new Cesium.ImageryLayer(provider),
  requestRender(viewer) {
    viewer?.scene?.requestRender?.();
  },
  globeShown: (viewer) => viewer?.scene?.globe?.show === true,
  setGlobeShown(viewer, shown) {
    viewer.scene.globe.show = shown;
  },
  addTileset(viewer, tileset) {
    viewer.scene.primitives.add(tileset);
  },
  removeTileset(viewer, tileset) {
    viewer.scene.primitives.remove(tileset);
  },
  tilesetShown: (tileset) => tileset?.show === true,
  showTileset(tileset, shown) {
    tileset.show = shown;
  },
  /** Below every other imagery layer, at `index`. */
  addImageryLayer(viewer, layer, index) {
    viewer.imageryLayers.add(layer, index);
  },
  /** Removed and destroyed. */
  removeImageryLayer(viewer, layer) {
    viewer.imageryLayers.remove(layer, true);
  },
  /** A terrain factory's result: `{terrain}` or `{provider}`. */
  applyTerrain(viewer, result) {
    if (result.terrain) viewer.scene.setTerrain(result.terrain);
    else viewer.terrainProvider = result.provider;
  },
  /**
   * Hear an imagery provider's failed tile requests, each with the times
   * Cesium retried it; null when the provider reports none.
   * @returns {(() => void) | null} Stop hearing them.
   */
  onTileError(provider, listener) {
    const errorEvent = provider?.errorEvent;
    if (!errorEvent?.addEventListener) return null;
    return errorEvent.addEventListener((error) =>
      listener({ timesRetried: error?.timesRetried }),
    );
  },
  isDestroyed: (value) => value?.isDestroyed?.() === true,
  /** Destroy a provider or tileset unless it is already destroyed. */
  release(value) {
    if (typeof value?.destroy === 'function' && !value.isDestroyed?.())
      value.destroy();
  },
});

provideMapEngine(cesiumMapEngine);
