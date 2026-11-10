// Map sources on a Cesium viewer. Sources are maps/registry.js entries
// ({ descriptor, imagery(), credit } and terrain { id, create() }) or plain
// descriptions ({ kind, style?, accessToken? }); providers come from the
// shared factories in src/maps, as MapSourceController builds them.

import * as Cesium from 'cesium';
import { createEngineEvent } from '../contract.js';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { createMapScene } from './mapScene.js';
import { ESRI_ATTRIBUTION_HTML, imageryFactoryFor } from './mapImagery.js';
import { applyTerrain, terrainSourceFor } from './terrain.js';

const IMAGERY_KINDS = new Set(['osm', 'esri-imagery', 'sentinel2', 'ion']);

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
 *   credits?: object,
 *   loadPhotorealTileset?: (credentials: object) => Promise<{ tileset: object | null, errors: Error[] }>,
 * }} [options] `tilesetRef` names the startup Google tileset the app added.
 * @returns {{ maps: object, tilesets: () => object[], destroy: () => void }}
 */
export function createCesiumMaps(
  viewer,
  {
    tilesetRef = null,
    requestRender = () => viewer.scene.requestRender?.(),
    createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
    credits,
    loadPhotorealTileset = (credentials) =>
      loadPhotorealisticTileset(Cesium, credentials),
  } = {},
) {
  const abort = new AbortController();
  const mapScene = createMapScene(viewer, {
    createImageryLayer,
    ...(credits && { credits }),
  });
  const providers = new Map();
  let ownedTileset = null;
  let shownTileset = null;
  // Every tileset shown through the engine, so a switch hides all of them;
  // `added` are those the engine put into scene.primitives itself.
  const known = new Set();
  const added = new Set();
  // Imagery and photoreal share one generation: whichever was asked for last
  // decides what the globe shows. Terrain has its own.
  const generations = { display: 0, terrain: 0 };
  let baseSource = null;
  // The source objects on screen, as passed (maps.current()).
  let currentBase = null;
  let currentTiles = null;
  let creditOwner = null;
  let destroyed = false;
  // Every terrain the globe takes counts, a fallback to the ellipsoid too.
  let terrainRevision = 0;
  let terrainSource = null;
  const errors = createEngineEvent();
  const errorRemovers = { tile: null, terrain: null };
  function watchErrors(provider, source, kind) {
    errorRemovers[kind]?.();
    errorRemovers[kind] = provider?.errorEvent?.addEventListener((error) => {
      if (destroyed) return;
      errors.raiseEvent({
        source,
        kind,
        status: error?.error?.statusCode ?? error?.statusCode ?? error?.status,
      });
    });
  }
  const offTerrain =
    viewer.scene.globe?.terrainProviderChanged?.addEventListener((provider) => {
      terrainRevision++;
      watchErrors(
        provider ?? viewer.scene.terrainProvider,
        terrainSource,
        'terrain',
      );
    });

  const startupTileset = () =>
    (typeof tilesetRef === 'function' ? tilesetRef() : tilesetRef?.current) ??
    null;
  const tilesets = () =>
    [startupTileset(), shownTileset, ownedTileset, ...known].filter(
      (tileset, index, all) => tileset && all.indexOf(tileset) === index,
    );

  // One provider per source, as MapSourceController caches them, so applying
  // the same source again keeps the live layer. Failures are not cached. A
  // source carrying a ready `provider` belongs to its caller: it is neither
  // cached nor disposed here.
  function providerFor(source) {
    if (source?.provider) return Promise.resolve(source.provider);
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

  function showCredit(owner, html) {
    creditOwner = owner;
    mapScene.showCredit(html);
  }

  function showBase(source, provider) {
    currentBase = source;
    watchErrors(provider, source, 'tile');
    mapScene.showBaseImagery(provider);
    showCredit('imagery', imageryCredit(source));
  }

  const maps = {
    errors,
    async setBaseImagery(source) {
      const generation = ++generations.display;
      const provider = await providerFor(source);
      if (destroyed || generation !== generations.display) return;
      baseSource = { source, provider };
      showBase(source, provider);
      requestRender('map-imagery');
    },
    async setTerrain(source) {
      const generation = ++generations.terrain;
      const result = await terrainCreator(source)({ signal: abort.signal });
      if (destroyed || generation !== generations.terrain) return;
      terrainSource = source;
      applyTerrain(viewer, result);
      if (result.provider) watchErrors(result.provider, source, 'terrain');
      requestRender('map-terrain');
    },
    async setPhotorealTiles(source) {
      const generation = ++generations.display;
      const { scene } = viewer;
      if (source == null) {
        mapScene.showTileset(null, tilesets());
        shownTileset = null;
        currentTiles = null;
        // The globe comes back with the last base imagery and its credit;
        // the photoreal credit goes.
        if (baseSource) {
          if (!mapScene.baseProvider)
            showBase(baseSource.source, baseSource.provider);
        } else if (creditOwner === 'photoreal') showCredit(null, null);
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
      if (destroyed || generation !== generations.display) {
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
      if (!scene.primitives.contains(tileset)) {
        scene.primitives.add(tileset);
        if (!owned) added.add(tileset);
      }
      known.add(tileset);
      // As MapSourceController activates a 3D stack: no base layer, the
      // source's credit, one tileset shown and the globe hidden.
      mapScene.removeBaseImagery();
      watchErrors(null, null, 'tile');
      currentBase = null;
      currentTiles = source;
      showCredit('photoreal', source.credit);
      shownTileset = tileset;
      mapScene.showTileset(tileset, tilesets());
      mapScene.showGlobe(false);
      requestRender('map-photoreal');
    },
    releasePhotorealTiles(source) {
      const tileset = source?.tileset;
      if (!tileset || !known.delete(tileset)) return;
      if (shownTileset === tileset) shownTileset = null;
      if (currentTiles?.tileset === tileset) currentTiles = null;
      if (added.delete(tileset)) viewer.scene.primitives.remove(tileset);
    },
    photorealActive: () => tilesets().some((tileset) => tileset.show === true),
    current: () => ({ baseImagery: currentBase, photoreal: currentTiles }),
    terrainRevision: () => terrainRevision,
  };

  return {
    maps,
    /** Every tileset the map may show (engine.imagery drapes on a shown one). */
    tilesets,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      offTerrain?.();
      for (const remove of Object.values(errorRemovers)) remove?.();
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
