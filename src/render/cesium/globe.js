/**
 * @module render/cesium/globe
 * @description The Cesium renderer's globe port (`src/render/contract/globe.d.ts`):
 * the base (photoreal tiles, terrain, imagery), the globe's visibility,
 * imagery layers (`imagery.js`), the split, the sky, settling and load
 * progress, over a Cesium widget or viewer someone else made.
 *
 * Imagery drapes on the globe, or on the drawn base tileset: the photoreal
 * tileset this port loaded, or one the application's map stack marked as
 * its base (`markBaseTileset`) while it still loads its own. Where each
 * layer drapes follows what is drawn, looked at every frame, so a base
 * switched outside the port moves the layers with it.
 *
 * The sky reads the scene as it was set up and writes through to it; what
 * the scene has no part for (stars without a sky box, say) is kept as set.
 */
import * as Cesium from 'cesium';
import { loadPhotorealisticTileset } from '../../maps/google3d.js';
import { provideUnboundGlobe } from '../rendererOf.js';
import { listenerList, uncaught } from './common.js';
import { createCesiumImagery } from './imagery.js';

/** Tilesets the application's map stack draws as its base. */
const baseTilesets = new WeakSet();

/**
 * Mark a tileset as a base the application draws outside the port, so
 * imagery drapes on it while it is shown. For code that still loads its
 * own base; the port's own photoreal tileset needs no mark.
 * @param {object} tileset Cesium `Cesium3DTileset`.
 */
export function markBaseTileset(tileset) {
  if (tileset && typeof tileset === 'object') baseTilesets.add(tileset);
}

/** Ion's world terrain asset. */
const WORLD_TERRAIN_ASSET = 1;
const ROUTES = {
  'google-direct': 'google',
  'google-token': 'google',
  'google-ion': 'fallback',
};

/** Heights of one DEM tile, decoded from its RGB pixels. */
function decodeHeights(pixels, encoding) {
  const heights = new Float32Array(pixels.length / 4);
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    heights[i] =
      encoding === 'mapbox'
        ? -10000 + (r * 65536 + g * 256 + b) * 0.1
        : r * 256 + g + b / 256 - 32768;
  }
  return heights;
}

/** A terrain provider for a heightmap DEM pyramid. */
function heightmapTerrain(spec) {
  if (spec.geoid)
    throw new TypeError('Geoid-relative heightmaps are not supported yet');
  const size = 256;
  return new Cesium.CustomHeightmapTerrainProvider({
    width: size,
    height: size,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    callback: async (x, y, level) => {
      // Past the pyramid a tile fails, and the globe refines its parent's.
      if (spec.maxLevel !== undefined && level > spec.maxLevel)
        throw new RangeError('Past the heightmap’s deepest level');
      const url = spec.url
        .replaceAll('{x}', String(x))
        .replaceAll('{y}', String(y))
        .replaceAll('{z}', String(level));
      const image = await Cesium.Resource.fetchImage({
        url,
        preferImageBitmap: true,
      });
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, size, size);
      return decodeHeights(
        context.getImageData(0, 0, size, size).data,
        spec.encoding,
      );
    },
  });
}

/** The terrain provider a spec describes, once ready. */
async function terrainProvider(spec, { worldDataToken }) {
  if (!spec || spec.kind === 'ellipsoid')
    return new Cesium.EllipsoidTerrainProvider();
  if (spec.kind === 'quantizedMesh')
    return Cesium.CesiumTerrainProvider.fromUrl(spec.url, {
      requestVertexNormals: spec.requestVertexNormals ?? false,
    });
  if (spec.kind === 'world') {
    const accessToken = String(worldDataToken || '').trim();
    if (!accessToken)
      throw new TypeError(
        'World terrain needs the renderer’s world data token',
      );
    const resource = await Cesium.IonResource.fromAssetId(WORLD_TERRAIN_ASSET, {
      accessToken,
    });
    return Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: spec.requestVertexNormals ?? false,
      requestWaterMask: false,
    });
  }
  if (spec.kind === 'heightmap') return heightmapTerrain(spec);
  throw new TypeError(`Unknown terrain kind: ${spec.kind}`);
}

/**
 * @param {object} widget A Cesium `CesiumWidget` or `Viewer`.
 * @param {{capabilities: ReadonlySet<string>,
 *   requestRender: (reason: string) => void,
 *   report?: (error: unknown) => void,
 *   credits?: import('../contract/credits').CreditsPort | null,
 *   credentials?: {googleApiKey?: string, googleTokens?: () => Promise<string>,
 *     worldDataToken?: string}}} options
 * @returns {{port: import('../contract/globe').GlobePort, dispose: () => void}}
 */
export function createCesiumGlobe(
  widget,
  {
    capabilities,
    requestRender,
    report = uncaught,
    credits = null,
    credentials = {},
  },
) {
  const scene = widget.scene;
  const can = (capability) => capabilities.has(capability);
  let disposed = false;

  // --- Base ------------------------------------------------------------------

  /** The photoreal tileset this port loaded, if any. */
  let photoreal = null;
  let photorealStatus = { route: 'none' };
  let photorealGen = 0;
  let terrainGen = 0;
  let baseCredit = null;

  /** Every 3D tileset the scene holds. */
  function tilesets() {
    const found = [];
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }

  /** The base tileset drawn now, which `objects` imagery drapes on. */
  function drawnBase() {
    if (photoreal && !photoreal.isDestroyed() && photoreal.show)
      return photoreal;
    for (const tileset of tilesets())
      if (baseTilesets.has(tileset) && tileset.show && !tileset.isDestroyed())
        return tileset;
    return null;
  }

  const imagery = createCesiumImagery(scene, {
    capabilities,
    requestRender,
    report,
    objects: drawnBase,
    worldDataToken: () => credentials.worldDataToken,
  });

  function removePhotoreal() {
    if (!photoreal) return;
    const tileset = photoreal;
    photoreal = null;
    // The layers draped on it move off before it takes them with it.
    imagery.sync();
    if (!tileset.isDestroyed() && !scene.primitives.remove(tileset))
      tileset.destroy();
  }

  async function setPhotoreal(spec) {
    const gen = ++photorealGen;
    removePhotoreal();
    photorealStatus = { route: 'none' };
    if (!spec || !can('photoreal')) {
      photorealStatus = { route: 'none' };
      requestRender('base');
      return photorealStatus;
    }
    // The spec's own route first: its key, else its tokens, else the
    // renderer's credentials.
    const googleApiKey =
      spec.key ?? (spec.token ? '' : (credentials.googleApiKey ?? ''));
    const token = spec.token ?? credentials.googleTokens;
    const result = await loadPhotorealisticTileset(Cesium, {
      googleApiKey,
      // A renewal names the token it replaces.
      googleTokens: token ? { token: (options) => token(options) } : null,
      cesiumToken: spec.fallback ? (credentials.worldDataToken ?? '') : '',
    });
    if (gen !== photorealGen || disposed) {
      if (result.tileset && !result.tileset.isDestroyed())
        result.tileset.destroy();
      return photorealStatus;
    }
    if (!result.tileset) {
      const error = result.errors.at(-1);
      photorealStatus = {
        route: 'none',
        error: {
          code: error ? 'load-failed' : 'no-credentials',
          message: error?.message ?? 'No photoreal credentials were given',
        },
      };
    } else {
      photoreal = scene.primitives.add(result.tileset);
      photorealStatus = { route: ROUTES[result.route] ?? 'google' };
    }
    imagery.sync();
    requestRender('base');
    return photorealStatus;
  }

  async function setTerrain(spec) {
    if (spec && spec.kind !== 'ellipsoid' && !can('terrain'))
      throw new TypeError('This renderer draws no terrain');
    // The last call wins, even one whose terrain then fails to load.
    const gen = ++terrainGen;
    const provider = await terrainProvider(spec, credentials);
    if (gen !== terrainGen || disposed) {
      if (!provider.isDestroyed?.()) provider.destroy?.();
      return;
    }
    scene.terrainProvider = provider;
    scene.verticalExaggeration = spec?.exaggeration ?? 1;
    requestRender('base');
  }

  async function setBase(base) {
    if (base.vector) throw new TypeError('This renderer draws no vector base');
    for (const handle of imagery.list()) handle.remove();
    baseCredit?.();
    baseCredit = base.credit && credits ? credits.addStatic(base.credit) : null;
    const loads = [];
    if (base.photoreal !== undefined) loads.push(setPhotoreal(base.photoreal));
    if (base.terrain !== undefined) loads.push(setTerrain(base.terrain));
    const layers = (base.imagery ?? []).map((spec) =>
      imagery.add(spec, undefined, { base: true }),
    );
    await Promise.all(loads);
    await imagery.ready(layers);
    await baseSettled();
    return {
      photoreal: photorealStatus,
      imagery: layers,
      settled: isSettled('base'),
    };
  }

  /** How long `setBase` waits for the new base to settle. */
  const BASE_SETTLE_MS = 20000;

  /**
   * Resolves once the base has settled, checked after each drawn frame, or
   * after `BASE_SETTLE_MS`; `setBase` then says whether it had.
   */
  function baseSettled() {
    if (isSettled('base') || !scene.postRender?.addEventListener)
      return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        off();
        clearTimeout(timer);
        settleWaits.delete(done);
        resolve();
      };
      const off = scene.postRender.addEventListener(() => {
        // Loads draw on their own as they land; no frame is asked for.
        if (isSettled('base')) done();
      });
      const timer = setTimeout(done, BASE_SETTLE_MS);
      settleWaits.add(done);
      requestRender('base');
    });
  }
  const settleWaits = new Set();

  // --- Sky -------------------------------------------------------------------

  const sky = {
    atmosphere:
      scene.skyAtmosphere?.show ?? scene.globe?.showGroundAtmosphere ?? false,
    atmosphereTuning: {
      brightness: scene.skyAtmosphere?.brightnessShift ?? 0,
      hueShift: scene.skyAtmosphere?.hueShift ?? 0,
      saturation: scene.skyAtmosphere?.saturationShift ?? 0,
    },
    stars: scene.skyBox?.show ?? false,
    milkyWay: scene.skyBox?.milkyWayVisibility ?? 0,
    sun: scene.sun?.show ?? false,
    moon: scene.moon?.show ?? false,
    fog: scene.fog?.enabled ?? false,
    lighting: scene.globe?.enableLighting ?? false,
  };

  /** The settings as drawn: the scene's own parts, else what was set. */
  function readSky() {
    const out = { ...sky, atmosphereTuning: { ...sky.atmosphereTuning } };
    if (scene.skyAtmosphere) out.atmosphere = scene.skyAtmosphere.show;
    else if (scene.globe) out.atmosphere = scene.globe.showGroundAtmosphere;
    if (scene.skyBox && 'show' in scene.skyBox) out.stars = scene.skyBox.show;
    if (scene.skyBox?.milkyWayVisibility !== undefined)
      out.milkyWay = scene.skyBox.milkyWayVisibility;
    if (scene.sun) out.sun = scene.sun.show;
    if (scene.moon) out.moon = scene.moon.show;
    if (scene.fog) out.fog = scene.fog.enabled;
    if (scene.globe) out.lighting = scene.globe.enableLighting;
    return out;
  }

  function setSky(settings) {
    const { atmosphereTuning, ...rest } = settings;
    Object.assign(sky, rest);
    if (atmosphereTuning)
      sky.atmosphereTuning = { ...sky.atmosphereTuning, ...atmosphereTuning };
    if ('atmosphere' in settings) {
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = sky.atmosphere;
      if (scene.globe) scene.globe.showGroundAtmosphere = sky.atmosphere;
    }
    if (atmosphereTuning && scene.skyAtmosphere) {
      const tuning = sky.atmosphereTuning;
      if (tuning.brightness !== undefined)
        scene.skyAtmosphere.brightnessShift = tuning.brightness;
      if (tuning.hueShift !== undefined)
        scene.skyAtmosphere.hueShift = tuning.hueShift;
      if (tuning.saturation !== undefined)
        scene.skyAtmosphere.saturationShift = tuning.saturation;
    }
    if ('stars' in settings && scene.skyBox && 'show' in scene.skyBox)
      scene.skyBox.show = sky.stars;
    if (
      'milkyWay' in settings &&
      scene.skyBox?.milkyWayVisibility !== undefined
    )
      scene.skyBox.milkyWayVisibility = sky.milkyWay;
    if ('sun' in settings && scene.sun) scene.sun.show = sky.sun;
    if ('moon' in settings && scene.moon) scene.moon.show = sky.moon;
    if ('fog' in settings && scene.fog) scene.fog.enabled = sky.fog;
    if ('lighting' in settings && scene.globe)
      scene.globe.enableLighting = sky.lighting;
    requestRender('sky');
  }

  // --- Settling and progress ---------------------------------------------

  const terrainLoaded = () =>
    !scene.globe?.show || scene.globe.tilesLoaded !== false;
  const tilesLoaded = () => {
    const base = drawnBase();
    return !base || base.tilesLoaded !== false;
  };
  const imageryLoaded = () => imagery.pending() === 0 && terrainLoaded();

  function isSettled(kind) {
    if (kind === 'terrain') return terrainLoaded();
    if (kind === 'tiles') return tilesLoaded();
    if (kind === 'imagery') return imageryLoaded();
    return terrainLoaded() && tilesLoaded() && imageryLoaded();
  }

  const progressListeners = listenerList(report);
  const progress = { tilesPending: 0, imageryPending: 0, terrainPending: 0 };
  let lastProgress = '';
  function emitProgress() {
    progress.imageryPending = imagery.pending();
    const key = `${progress.tilesPending}/${progress.imageryPending}/${progress.terrainPending}`;
    if (key === lastProgress || progressListeners.size === 0) return;
    lastProgress = key;
    progressListeners.fire({ ...progress });
  }
  const removers = [];
  const globeProgress = scene.globe?.tileLoadProgressEvent;
  if (globeProgress?.addEventListener)
    removers.push(
      globeProgress.addEventListener((queued) => {
        progress.terrainPending = queued;
        emitProgress();
      }),
    );

  // Every tick: where each layer drapes follows what is drawn, and the base
  // tileset's load progress is read.
  if (scene.preUpdate?.addEventListener)
    removers.push(
      scene.preUpdate.addEventListener(() => {
        // A throw here would stop the widget's render loop.
        try {
          if (imagery.list().length) imagery.sync();
          if (progressListeners.size === 0) return;
          const base = drawnBase();
          progress.tilesPending = base && !base.tilesLoaded ? 1 : 0;
          emitProgress();
        } catch (error) {
          report(error);
        }
      }),
    );

  // --- Port ------------------------------------------------------------------

  const port = {
    setBase,
    setPhotoreal,
    setTerrain,
    setGlobeVisible(visible) {
      if (!scene.globe) return;
      scene.globe.show = Boolean(visible);
      imagery.sync();
      requestRender('base');
    },
    imagery: {
      add: (spec, index) => imagery.add(spec, index),
      list: imagery.list,
    },
    sky: { get: readSky, set: setSky },
    isSettled,
    on(event, cb) {
      if (event !== 'progress') return () => {};
      return progressListeners.on(cb);
    },
  };
  if (can('splitSwipe')) {
    // Cesium's split starts at the canvas's left edge, as the scene was
    // made: a `left` layer shows once the split moves.
    port.imagery.getSplit = () => scene.splitPosition ?? 0;
    port.imagery.setSplit = (x01) => {
      scene.splitPosition = Math.min(1, Math.max(0, Number(x01)));
      requestRender('imagery');
    };
  }

  return {
    port,
    dispose() {
      if (disposed) return;
      disposed = true;
      photorealGen += 1;
      terrainGen += 1;
      for (const off of removers) off();
      progressListeners.clear();
      for (const done of [...settleWaits]) done();
      imagery.dispose();
      baseCredit?.();
      baseCredit = null;
    },
  };
}

// A viewer of a consumer's own, with no renderer bound, gets a globe port
// built over it: imagery and the sky as the renderer's would.
provideUnboundGlobe((viewer) => {
  if (!viewer?.scene) return null;
  const { port, dispose } = createCesiumGlobe(viewer, {
    capabilities: new Set(['imageHooks', 'imageryOnTiles', 'splitSwipe']),
    requestRender: () => viewer.scene.requestRender?.(),
  });
  // A renderer bound later leaves it running: its layers keep following
  // the base until their callers remove them.
  return { port, dispose, release() {} };
});
