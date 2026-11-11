/**
 * @module render/cesium/mapEngine
 * @description The Cesium map engine (`src/maps/engine.js`): the providers
 * the map stacks' imagery and terrain come from (`mapImagery.js`,
 * `mapTerrain.js`), the photoreal base the application scene loads
 * (`google3d.js`), and the viewer operations the map source controller
 * switches stacks with. Each operation takes the scene object: the viewer
 * behind it (`viewers.js`) is the one it changes. Provided as this module
 * loads, for viewers with no renderer bound, and handed to the application
 * with each renderer the plugin makes (`appRenderer.js`).
 */
import * as Cesium from 'cesium';
import { provideMapEngine } from '../../maps/engine.js';
import { loadPhotorealisticTileset } from './google3d.js';
import { viewerBehind } from './viewers.js';
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
  requestRender(host) {
    viewerBehind(host)?.scene?.requestRender?.();
  },
  globeShown: (host) => viewerBehind(host)?.scene?.globe?.show === true,
  setGlobeShown(host, shown) {
    viewerBehind(host).scene.globe.show = shown;
  },
  addTileset(host, tileset) {
    viewerBehind(host).scene.primitives.add(tileset);
  },
  /** Removed, which destroys it. */
  removeTileset(host, tileset) {
    viewerBehind(host).scene.primitives.remove(tileset);
  },
  tilesetShown: (tileset) => tileset?.show === true,
  showTileset(tileset, shown) {
    tileset.show = shown;
  },
  /** Below every other imagery layer, at `index`. */
  addImageryLayer(host, layer, index) {
    viewerBehind(host).imageryLayers.add(layer, index);
  },
  /** Removed and destroyed. */
  removeImageryLayer(host, layer) {
    viewerBehind(host).imageryLayers.remove(layer, true);
  },
  /** A terrain factory's result: `{terrain}` or `{provider}`. */
  applyTerrain(host, result) {
    const viewer = viewerBehind(host);
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
  /**
   * Load Google Photorealistic 3D Tiles by the best route the credentials
   * allow (`google3d.js`); the tileset is not yet drawn.
   * @param {object} host
   * @param {{googleApiKey?: string, googleTokens?: object|null, cesiumToken?: string}} credentials
   * @returns {Promise<{tileset: object|null, route: string, errors: Error[]}>}
   */
  loadPhotoreal: (host, credentials) =>
    loadPhotorealisticTileset(Cesium, credentials),
});

provideMapEngine(cesiumMapEngine);
