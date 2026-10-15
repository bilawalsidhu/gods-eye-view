// Map sources on a Cesium viewer. Sources are maps/registry.js entries
// ({ descriptor, imagery(), credit } and terrain { id, create() }) or plain
// descriptions ({ kind, style?, accessToken? }); providers come from the
// shared factories in src/maps, as MapSourceController builds them.

import * as Cesium from 'cesium';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { createMapScene } from '../../maps/sceneApply.js';
import {
  ESRI_ATTRIBUTION_HTML,
  imageryFactoryFor,
} from '../../maps/imagery.js';
import { applyTerrain, terrainSourceFor } from '../../maps/terrain.js';

const IMAGERY_KINDS = new Set(['osm', 'esri-imagery', 'ion']);

function imageryCreator(source) {
  if (typeof source?.imagery === 'function') return source.imagery;
  const descriptor = source?.descriptor ?? source;
  if (!IMAGERY_KINDS.has(descriptor?.kind))
    throw new TypeError(`Unknown imagery source: ${descriptor?.kind}`);
  return imageryFactoryFor(descriptor, source.accessToken);
}

// Registry sources are stable by id; plain descriptions by kind and style.
const imageryKey = (source) =>
  source?.descriptor?.id ?? `${source?.kind}:${source?.style ?? ''}`;

function imageryCredit(source) {
  if (source?.credit !== undefined) return source.credit;
  const kind = (source?.descriptor ?? source)?.kind;
  return kind === 'esri-imagery' ? ESRI_ATTRIBUTION_HTML : null;
}

function terrainCreator(source) {
  if (typeof source?.create === 'function') return source.create;
  switch (source?.kind) {
    case 'ellipsoid':
      return () => ({ provider: new Cesium.EllipsoidTerrainProvider() });
    case 'keyless':
      return terrainSourceFor('').create;
    case 'world': {
      const token = String(source.accessToken || '').trim();
      if (!token)
        return () => {
          throw new Error('World terrain requires an explicit ion token');
        };
      return terrainSourceFor(token).create;
    }
    default:
      throw new TypeError(`Unknown terrain source: ${source?.kind}`);
  }
}

const dispose = (value) => {
  if (typeof value?.destroy === 'function' && !value.isDestroyed?.())
    value.destroy();
};

/**
 * @param {Cesium.Viewer} viewer
 * @param {{
 *   tilesetRef?: { current: object | null } | (() => object | null),
 *   requestRender?: (reason: string) => void,
 *   createImageryLayer?: (provider: object) => object,
 *   loadPhotorealTileset?: (credentials: object) => Promise<{ tileset: object | null, errors: Error[] }>,
 * }} [options] `tilesetRef` names the startup Google tileset the app added.
 * @returns {{ maps: object, destroy: () => void }}
 */
export function createCesiumMaps(
  viewer,
  {
    tilesetRef = null,
    requestRender = () => viewer.scene.requestRender?.(),
    createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
    loadPhotorealTileset = (credentials) =>
      loadPhotorealisticTileset(Cesium, credentials),
  } = {},
) {
  const abort = new AbortController();
  const mapScene = createMapScene(viewer, { createImageryLayer });
  const providers = new Map();
  let ownedTileset = null;
  let shownTileset = null;
  const generations = { imagery: 0, terrain: 0, photoreal: 0 };
  let destroyed = false;

  const startupTileset = () =>
    (typeof tilesetRef === 'function' ? tilesetRef() : tilesetRef?.current) ??
    null;
  const tilesets = () =>
    [startupTileset(), shownTileset, ownedTileset].filter(
      (tileset, index, all) => tileset && all.indexOf(tileset) === index,
    );

  // One provider per source, as MapSourceController caches them, so applying
  // the same source again keeps the live layer. Failures are not cached.
  function providerFor(source) {
    const key = imageryKey(source);
    if (providers.has(key)) return providers.get(key);
    const promise = Promise.resolve()
      .then(() => imageryCreator(source)({ signal: abort.signal }))
      .catch((error) => {
        if (providers.get(key) === promise) providers.delete(key);
        throw error;
      });
    providers.set(key, promise);
    return promise;
  }

  const maps = {
    async setBaseImagery(source) {
      const generation = ++generations.imagery;
      const provider = await providerFor(source);
      if (destroyed || generation !== generations.imagery) return;
      mapScene.showBaseImagery(provider);
      mapScene.showCredit(imageryCredit(source));
      requestRender('map-imagery');
    },
    async setTerrain(source) {
      const generation = ++generations.terrain;
      const result = await terrainCreator(source)({ signal: abort.signal });
      if (destroyed || generation !== generations.terrain) return;
      applyTerrain(viewer, result);
      requestRender('map-terrain');
    },
    async setPhotorealTiles(source) {
      const generation = ++generations.photoreal;
      const { scene } = viewer;
      if (source == null) {
        mapScene.showTileset(null, tilesets());
        shownTileset = null;
        mapScene.showGlobe(true);
        requestRender('map-photoreal');
        return;
      }
      let tileset = source.tileset ?? null;
      let owned = false;
      if (!tileset) {
        const { tileset: loaded, errors = [] } =
          await loadPhotorealTileset(source);
        if (!loaded)
          throw errors.at(-1) ?? new Error('Google 3D Tiles are unavailable');
        tileset = loaded;
        owned = true;
      }
      if (destroyed || generation !== generations.photoreal) {
        if (owned) dispose(tileset);
        return;
      }
      if (owned && ownedTileset !== tileset) {
        if (ownedTileset) {
          scene.primitives.remove(ownedTileset);
          dispose(ownedTileset);
        }
        ownedTileset = tileset;
      }
      if (!scene.primitives.contains(tileset)) scene.primitives.add(tileset);
      // As MapSourceController activates a 3D stack: no base layer, the
      // source's credit, one tileset shown and the globe hidden.
      mapScene.removeBaseImagery();
      mapScene.showCredit(source.credit);
      shownTileset = tileset;
      mapScene.showTileset(tileset, tilesets());
      mapScene.showGlobe(false);
      requestRender('map-photoreal');
    },
    photorealActive: () => tilesets().some((tileset) => tileset.show === true),
  };

  return {
    maps,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      mapScene.destroy();
      for (const promise of providers.values())
        void promise.then(dispose, () => {});
      providers.clear();
      if (ownedTileset) {
        viewer.scene.primitives.remove(ownedTileset);
        dispose(ownedTileset);
        ownedTileset = null;
      }
    },
  };
}
