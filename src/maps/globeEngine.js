/**
 * @module maps/globeEngine
 * @description The map engine (`engine.js`) over the renderer contract's
 * globe port, for when the renderer's plugin hands the application no map
 * engine of its own (`src/render/applicationHooks.js`). The map stacks'
 * sources become the port's specs: Esri and OSM as `xyz` imagery, Cesium
 * ion's world imagery as `world` imagery, the photoreal stack as the port's
 * photoreal base, and terrain as `world` terrain (or the ellipsoid where the
 * port has no keyless terrain to offer).
 *
 * What the map stack holds is what this engine hands it: a spec per imagery
 * provider, a handle per imagery layer and photoreal base. A hidden
 * photoreal base is turned off through the port and on again when shown.
 */
import { findFrame, findGlobe } from '../render/rendererOf.js';

const ESRI_TILES =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_CREDIT =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_CREDIT = '© OpenStreetMap contributors';
/** Cesium ion's world imagery assets (`MAP_STACKS`' `style`). */
const WORLD_STYLES = { 2: 'aerial', 3: 'aerialLabels' };

/** Values this engine released: never used again. */
const released = new WeakSet();
/** The layer an imagery spec is drawn by, while it is drawn. */
const layers = new WeakMap();
/** Whether each globe port's surface is shown, as last set here. */
const shownGlobes = new WeakMap();

const credit = (text) => ({ text });

/**
 * Turn a photoreal handle's base on or off. Turning it on can fail (the
 * port answers route `none`, or rejects): the handle is then off again, so
 * a later switch tries again, and the globe is shown so the base is not
 * left blank. Only the latest switch of a handle settles it.
 */
function applyPhotoreal(handle, shown) {
  if (handle.shown === shown || released.has(handle)) return;
  handle.shown = shown;
  const switchId = (handle.switches = (handle.switches ?? 0) + 1);
  const failed = (error) => {
    if (handle.switches !== switchId || released.has(handle)) return;
    console.warn('[MapStack] photoreal switch failed', error);
    if (!shown) return;
    handle.shown = false;
    handle.globe.setGlobeVisible(true);
    shownGlobes.set(handle.globe, true);
  };
  handle.globe.setPhotoreal(shown ? handle.spec : null).then((status) => {
    if (shown && status?.route === 'none')
      failed(status.error?.message ?? 'photoreal unavailable');
  }, failed);
}

/**
 * Load the photoreal base through `host`'s globe port with the credentials
 * the scene holds. The port's own routes decide among them (Google's key or
 * session tokens, then the renderer's fallback copy).
 * @param {object} host
 * @param {{googleApiKey?: string, googleTokens?: {token: Function}|null,
 *   cesiumToken?: string}} credentials
 * @returns {Promise<{tileset: object|null, route: string, errors: Error[]}>}
 */
async function loadPhotoreal(
  host,
  { googleApiKey = '', googleTokens = null, cesiumToken = '' } = {},
) {
  const globe = findGlobe(host);
  const key = String(googleApiKey || '').trim();
  const fallback = Boolean(String(cesiumToken || '').trim());
  if (!globe || (!key && !googleTokens && !fallback))
    return { tileset: null, route: 'none', errors: [] };
  const spec = {
    provider: 'google',
    ...(key ? { key } : {}),
    ...(!key && googleTokens
      ? { token: (options) => googleTokens.token(options) }
      : {}),
    fallback,
  };
  try {
    const status = await globe.setPhotoreal(spec);
    if (status?.route && status.route !== 'none')
      return {
        tileset: { spec, globe, shown: true },
        route: status.route,
        errors: [],
      };
    const error = status?.error;
    return {
      tileset: null,
      route: 'none',
      errors: error ? [new Error(error.message || error.code)] : [],
    };
  } catch (error) {
    return {
      tileset: null,
      route: 'none',
      errors: [error instanceof Error ? error : new Error(String(error))],
    };
  }
}

export const globeMapEngine = Object.freeze({
  imagery: Object.freeze({
    osm: () =>
      Object.freeze({
        kind: 'xyz',
        url: OSM_TILES,
        tiling: 'webMercator',
        maxLevel: 19,
        credit: credit(OSM_CREDIT),
      }),
    esri: () =>
      Object.freeze({
        kind: 'xyz',
        url: ESRI_TILES,
        tiling: 'webMercator',
        maxLevel: 19,
        credit: credit(ESRI_CREDIT),
      }),
    ion(style, accessToken) {
      if (!String(accessToken || '').trim())
        throw new Error('Ion imagery requires an explicit token');
      return Object.freeze({
        kind: 'world',
        worldStyle: WORLD_STYLES[style] ?? 'aerial',
      });
    },
  }),
  terrain: Object.freeze({
    world: async (accessToken) => {
      if (!String(accessToken || '').trim())
        throw new Error('World terrain requires an explicit ion token');
      return {
        provider: null,
        spec: { kind: 'world', requestVertexNormals: true },
      };
    },
    keyless: async () => ({ provider: null, spec: { kind: 'ellipsoid' } }),
  }),
  createImageryLayer: (spec) => ({ spec, layer: null }),
  requestRender(host) {
    findFrame(host)?.requestRender('map-stack');
  },
  globeShown(host) {
    const globe = findGlobe(host);
    if (!globe) return false;
    return globe.isGlobeVisible?.() ?? shownGlobes.get(globe) ?? true;
  },
  setGlobeShown(host, shown) {
    const globe = findGlobe(host);
    if (!globe) return;
    globe.setGlobeVisible(shown);
    shownGlobes.set(globe, shown);
  },
  addTileset() {},
  removeTileset(host, handle) {
    if (handle) applyPhotoreal(handle, false);
  },
  tilesetShown: (handle) => handle?.shown === true,
  showTileset(handle, shown) {
    if (handle) applyPhotoreal(handle, shown);
  },
  addImageryLayer(host, handle, index) {
    const globe = findGlobe(host);
    if (!globe || released.has(handle)) return;
    handle.layer = globe.imagery.add(handle.spec, index);
    layers.set(handle.spec, handle.layer);
  },
  removeImageryLayer(host, handle) {
    if (layers.get(handle.spec) === handle.layer) layers.delete(handle.spec);
    handle.layer?.remove();
    handle.layer = null;
  },
  applyTerrain(host, result) {
    findGlobe(host)
      ?.setTerrain(result.spec ?? null)
      .catch((error) => console.warn('[MapStack] terrain failed', error));
  },
  /**
   * Hear the failed tile requests of the layer drawing `spec`; null while
   * none draws it. The port does not say how often a tile was retried.
   */
  onTileError(spec, listener) {
    const layer = layers.get(spec);
    if (!layer) return null;
    return layer.on('tileError', () => listener({}));
  },
  isDestroyed: (value) => Boolean(value) && released.has(value),
  release(value) {
    if (!value || typeof value !== 'object' || released.has(value)) return;
    if (value.globe && value.spec) applyPhotoreal(value, false);
    released.add(value);
  },
  loadPhotoreal,
});
