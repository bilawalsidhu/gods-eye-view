/**
 * @module render/cesium/globe
 * @description The Cesium renderer's globe port (`src/render/contract/globe.d.ts`):
 * the base (photoreal tiles, terrain, imagery), the globe's visibility,
 * imagery layers (`imagery.js`), the split, the sky, settling and load
 * progress, over a Cesium widget or viewer someone else made.
 *
 * Imagery drapes on the globe, or on the drawn base tileset: the photoreal
 * tileset this port loaded, or one the application's map stack marked as
 * its base (`markBaseTileset`, `../baseTilesets.js`) while it still loads
 * its own. Where each layer drapes follows what is drawn, looked at every
 * frame, so a base switched outside the port moves the layers with it.
 *
 * The sky reads the scene as it was set up and writes through to it; what
 * the scene has no part for (stars without a sky box, say) is kept as set.
 */
import * as Cesium from 'cesium';
import { loadPhotorealisticTileset } from './google3d.js';
import { provideUnboundGlobe } from '../rendererOf.js';
import { isBaseTileset, markBaseTileset } from '../baseTilesets.js';
import { listenerList, uncaught } from './common.js';
import { createCesiumImagery } from './imagery.js';
import { attributionText } from './vectorBase.js';
import { loadVectorStyle } from '../vectorBase/index.js';
import { createTerrainRetryPolicy } from '../../maps/terrainRetry.js';

// The base marks live outside the adapter, so code that is not Cesium's can
// mark a base; they are re-exported here for the code that still is.
export { markBaseTileset };

/** Ion's world terrain asset. */
const WORLD_TERRAIN_ASSET = 1;
const ROUTES = {
  'google-direct': 'google',
  'google-token': 'google',
  'google-ion': 'fallback',
};

/** The terrain provider a spec describes, once ready. */
async function terrainProvider(spec, { worldDataToken }) {
  if (!spec || spec.kind === 'ellipsoid')
    return new Cesium.EllipsoidTerrainProvider();
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
  if (spec.kind === 'quantizedMesh') {
    if (typeof spec.url !== 'string' || !spec.url)
      throw new TypeError('Quantized-mesh terrain needs its url');
    // Busy hosts are asked again as the keyless terrain is
    // (`terrainRetry.js`); every tile's resource inherits the policy.
    const policy = createTerrainRetryPolicy();
    const resource = new Cesium.Resource({
      url: spec.url,
      retryCallback: policy.retryCallback,
      retryAttempts: policy.retryAttempts,
    });
    return Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: spec.requestVertexNormals ?? false,
      requestWaterMask: false,
    });
  }
  throw new TypeError(`Unknown terrain kind: ${spec.kind}`);
}

/**
 * `hillshade` surface shading: view-directed display lighting over the
 * terrain's own normals, or the ellipsoid's curvature where the terrain
 * has none (Cesium leaves normal-dependent materials out without them). It
 * darkens only, up to `strength` opacity; it stands for no sun, changes no
 * geometry and asks for no data.
 * @param {boolean} terrainNormals
 */
function hillshadeSource(terrainNormals) {
  const normal = terrainNormals
    ? 'vec3 normal = normalize(materialInput.normalEC);'
    : `vec3 worldPosition = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
    vec3 geodeticNormal = normalize(worldPosition * czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii);
    vec3 normal = normalize(czm_viewRotation * geodeticNormal);`;
  return `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    ${normal}
    vec3 displayLight = normalize(vec3(-0.45, 0.55, 0.8));
    float shade = clamp((1.0 - dot(normal, displayLight)) * strength * (0.32 / 0.28), 0.0, strength);
    material.diffuse = vec3(0.0);
    material.alpha = shade;
    return material;
}
`;
}

/** The last `surfaceVersion` any globe port handed out. */
let surfaceVersions = 0;

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
  let baseGen = 0;
  /** The `setBase` call whose base is drawn now (a failed one changes none). */
  let drawnGen = 0;
  /** Aborts the style load of the `setBase` in flight, if any. */
  let baseLoad = null;
  let baseCredit = null;
  // The vector base's sources' credits.
  const vectorCredits = [];

  /**
   * Every 3D tileset the scene holds, into `found` (emptied first): the
   * per-frame readers pass `scratchTilesets` rather than make a list.
   */
  function tilesets(found = []) {
    found.length = 0;
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }
  const scratchTilesets = [];

  /** The base tileset drawn now, which `objects` imagery drapes on. */
  function drawnBase() {
    if (photoreal && !photoreal.isDestroyed() && photoreal.show)
      return photoreal;
    for (const tileset of tilesets(scratchTilesets))
      if (isBaseTileset(tileset) && tileset.show && !tileset.isDestroyed())
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
    if (base.vector && !can('vectorBase'))
      throw new TypeError('This renderer draws no vector base');
    // The last call wins: one superseded (or disposed) before its base
    // changes changes nothing and resolves with the base as it stands.
    const gen = ++baseGen;
    baseLoad?.abort();
    baseLoad = null;
    const current = () => gen === baseGen && !disposed;
    const superseded = () => ({
      photoreal: photorealStatus,
      imagery: [],
      settled: false,
    });
    if (disposed) return superseded();
    // The style loads before the base changes: one that fails changes
    // nothing.
    let style = null;
    if (base.vector) {
      const load = new AbortController();
      baseLoad = load;
      try {
        style = await loadVectorStyle(base.vector.styleUrl, undefined, {
          signal: load.signal,
        });
      } catch (error) {
        if (!current()) return superseded();
        throw error;
      } finally {
        if (baseLoad === load) baseLoad = null;
      }
      if (!current()) return superseded();
    }
    drawnGen = gen;
    for (const handle of imagery.list()) handle.remove();
    baseCredit?.();
    baseCredit = base.credit && credits ? credits.addStatic(base.credit) : null;
    for (const off of vectorCredits.splice(0)) off();
    if (style) {
      // Under any imagery the base also gives.
      imagery.add({ kind: 'vectorStyle', style }, undefined, { base: true });
      if (credits)
        for (const text of style.attribution.map(attributionText))
          if (text) vectorCredits.push(credits.addStatic({ text }));
    }
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
      // Settled when its base is still the one drawn: a later call changes
      // the base only once its style loads, and one whose style fails never
      // does (see the contract's setBase).
      settled: gen === drawnGen && !disposed && isSettled('base'),
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
    stars: scene.skyBox?.show ?? false,
    milkyWay: scene.skyBox?.milkyWayVisibility ?? 0,
    sun: scene.sun?.show ?? false,
    moon: scene.moon?.show ?? false,
    fog: scene.fog?.enabled ?? false,
    lighting: scene.globe?.enableLighting ?? false,
  };

  /** The settings as drawn: the scene's own parts, else what was set. */
  function readSky() {
    const out = { ...sky };
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
    Object.assign(sky, settings);
    if ('atmosphere' in settings) {
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = sky.atmosphere;
      if (scene.globe) scene.globe.showGroundAtmosphere = sky.atmosphere;
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

  /**
   * `surface`: what surface heights answer from has loaded what is in view:
   * the globe's terrain while it is shown, otherwise the shown 3D tiles;
   * false with neither drawn.
   */
  function surfaceLoaded() {
    if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
    let found = false;
    for (const tileset of tilesets(scratchTilesets)) {
      if (!tileset.show || tileset.isDestroyed?.()) continue;
      found = true;
      if (tileset.tilesLoaded === false) return false;
    }
    return found;
  }

  // `surfaceVersion`: bumped when what heights answer against changes, read
  // off the scene (so a base changed around the port counts too): whether
  // the globe is shown, its terrain provider, and the shown 3D tilesets.
  // Taken from one counter for every port, so no two surfaces share one.
  let surfaceVersion = 0;
  const surfaceSeen = { globe: null, terrain: null, tiles: new Set() };
  function readSurfaceVersion() {
    const globe = Boolean(scene.globe?.show);
    const terrain = scene.globe?.terrainProvider ?? null;
    let changed =
      surfaceSeen.globe !== globe || surfaceSeen.terrain !== terrain;
    // The shown tilesets as a set: their order among the primitives is no
    // change to the surface.
    let count = 0;
    for (const tileset of tilesets(scratchTilesets)) {
      if (!tileset.show || tileset.isDestroyed?.()) continue;
      count += 1;
      if (!surfaceSeen.tiles.has(tileset)) changed = true;
    }
    if (count !== surfaceSeen.tiles.size) changed = true;
    if (changed) {
      surfaceSeen.globe = globe;
      surfaceSeen.terrain = terrain;
      surfaceSeen.tiles.clear();
      for (const tileset of scratchTilesets)
        if (tileset.show && !tileset.isDestroyed?.())
          surfaceSeen.tiles.add(tileset);
      surfaceVersion = ++surfaceVersions;
    }
    return surfaceVersion;
  }

  function isSettled(kind) {
    if (kind === 'surface' && can('surfaceIdentity')) return surfaceLoaded();
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
          if (shadingStale()) {
            applyShading();
            requestRender('base');
          }
          if (imagery.size) imagery.sync();
          if (progressListeners.size === 0) return;
          const base = drawnBase();
          progress.tilesPending = base && !base.tilesLoaded ? 1 : 0;
          emitProgress();
        } catch (error) {
          report(error);
        }
      }),
    );

  // --- Surface shading --------------------------------------------------

  // `setSurfaceShading`: the globe material this port owns, while it shades.
  // It takes the globe's material only when no one else holds it, and gives
  // it back on null. On the tick after a change it follows the terrain
  // (with normals or without), lets go of a material someone replaced, and
  // takes the globe's material once it comes free.
  let shading = null;
  let shadingMaterial = null;
  let shadingNormals = null;
  // The terrain's normals when shading was last applied, owned or not, so
  // an idle tick never applies it again.
  let shadingSeen = null;
  // A material that could not be made is not retried until the terrain or
  // the shading changes.
  let shadingBroken = false;
  const shadingNormalsNow = () =>
    scene.globe?.terrainProvider?.hasVertexNormals === true;
  // Whether a tick should apply the shading again: the terrain's normals
  // changed, someone took our material, or the globe's material came free.
  function shadingStale() {
    const globe = scene.globe;
    if (!shading || !globe) return false;
    if (shadingSeen !== shadingNormalsNow()) return true;
    if (shadingMaterial) return globe.material !== shadingMaterial;
    return globe.material == null && !shadingBroken;
  }
  function dropShadingMaterial() {
    if (!shadingMaterial) return;
    if (scene.globe && scene.globe.material === shadingMaterial)
      scene.globe.material = undefined;
    if (!shadingMaterial.isDestroyed?.()) shadingMaterial.destroy?.();
    shadingMaterial = null;
    shadingNormals = null;
  }
  function applyShading() {
    const globe = scene.globe;
    const normals = shadingNormalsNow();
    if (normals !== shadingSeen) shadingBroken = false;
    shadingSeen = normals;
    if (!shading || !globe) return dropShadingMaterial();
    if (shadingMaterial && globe.material !== shadingMaterial) {
      // Someone else took the globe's material: theirs it stays, and ours,
      // no longer drawn, goes.
      if (!shadingMaterial.isDestroyed?.()) shadingMaterial.destroy?.();
      shadingMaterial = null;
      shadingNormals = null;
    }
    if (shadingMaterial && shadingNormals === normals) {
      shadingMaterial.uniforms.strength = shading.strength;
      return;
    }
    if (!shadingMaterial && globe.material != null) return;
    dropShadingMaterial();
    shadingBroken = true;
    shadingMaterial = new Cesium.Material({
      fabric: {
        type: normals ? 'GEVHillshadeTerrain' : 'GEVHillshadeCurvature',
        uniforms: { strength: shading.strength },
        source: hillshadeSource(normals),
      },
      translucent: true,
    });
    shadingBroken = false;
    shadingNormals = normals;
    globe.material = shadingMaterial;
  }
  function setSurfaceShading(next) {
    if (next && next.kind !== 'hillshade')
      throw new TypeError(`This renderer has no ${next.kind} shading`);
    shading = next
      ? { strength: Math.min(1, Math.max(0, Number(next.strength) || 0)) }
      : null;
    shadingBroken = false;
    applyShading();
    requestRender('base');
  }

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
  if (can('globeVisibility'))
    port.isGlobeVisible = () => scene.globe?.show === true;
  if (can('surfaceIdentity')) port.surfaceVersion = readSurfaceVersion;
  if (can('surfaceShading')) port.setSurfaceShading = setSurfaceShading;
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
      baseGen += 1;
      baseLoad?.abort();
      baseLoad = null;
      for (const off of removers) off();
      shading = null;
      dropShadingMaterial();
      progressListeners.clear();
      for (const done of [...settleWaits]) done();
      imagery.dispose();
      baseCredit?.();
      baseCredit = null;
      for (const off of vectorCredits.splice(0)) off();
    },
  };
}

// A viewer with no renderer bound gets a globe port
// built over it: imagery and the sky as the renderer's would.
provideUnboundGlobe((viewer) => {
  if (!viewer?.scene) return null;
  // Visibility reads back only from a globe that keeps it: a scene made
  // without one gives no reading, so its callers keep their own default.
  const capabilities = new Set([
    'imageHooks',
    'imageryOnTiles',
    'splitSwipe',
    'surfaceIdentity',
  ]);
  if (typeof viewer.scene.globe?.show === 'boolean')
    capabilities.add('globeVisibility');
  // The globe's surface shading needs a globe to shade.
  if (viewer.scene.globe) capabilities.add('surfaceShading');
  const { port, dispose } = createCesiumGlobe(viewer, {
    capabilities,
    requestRender: () => viewer.scene.requestRender?.(),
  });
  // A renderer bound later leaves it running: its layers keep following
  // the base until their callers remove them.
  return { port, dispose, release() {} };
});
