// Map sources on a Cesium viewer. Sources are maps/registry.js entries
// ({ descriptor, imagery(), credit } and terrain { id, create() }) or plain
// descriptions ({ kind, style?, accessToken? }); providers come from the
// shared factories in src/maps, as MapSourceController builds them.

import * as Cesium from 'cesium';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { createMapCredits } from '../../maps/credits.js';
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
  let credits = null;
  let layer = null;
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
  const showCredit = (html) => {
    credits ??= createMapCredits(viewer);
    credits.show(html);
  };

  const maps = {
    async setBaseImagery(source) {
      const generation = ++generations.imagery;
      const create = imageryCreator(source);
      const provider = await create({ signal: abort.signal });
      if (destroyed || generation !== generations.imagery) {
        dispose(provider);
        return;
      }
      const next = createImageryLayer(provider);
      viewer.imageryLayers.add(next, 0);
      if (layer) viewer.imageryLayers.remove(layer, true);
      layer = next;
      showCredit(imageryCredit(source));
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
        for (const tileset of tilesets()) tileset.show = false;
        shownTileset = null;
        scene.globe.show = true;
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
      for (const other of tilesets()) other.show = other === tileset;
      tileset.show = true;
      shownTileset = tileset;
      scene.globe.show = false;
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
      if (layer) viewer.imageryLayers.remove(layer, true);
      layer = null;
      credits?.destroy();
      if (ownedTileset) {
        viewer.scene.primitives.remove(ownedTileset);
        dispose(ownedTileset);
        ownedTileset = null;
      }
    },
  };
}
