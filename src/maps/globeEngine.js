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
import { findFrame, findGlobe, rendererOf } from '../render/rendererOf.js';
import { ESRI_IMAGERY_CREDIT, ESRI_TILES } from './attribution.js';
import { KEYLESS_TERRAIN_URL } from './keylessTerrain.js';

/** Esri World Imagery's deepest level (its tile info lists levels 0–23). */
const ESRI_MAX_LEVEL = 23;
/**
 * A tile Esri has no imagery for: it answers every such tile with this one
 * "Map data not yet available" picture, the same bytes each time.
 */
const ESRI_MISSING_TILE =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/23/0/0';
const OSM_MAX_LEVEL = 19;
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

/** Esri's "no imagery here" picture's bytes, once read; null if unread. */
let esriMissing = null;

/** Read Esri's "no imagery here" picture, once; null while it cannot be. */
function esriMissingTile() {
  esriMissing ??= fetch(ESRI_MISSING_TILE)
    .then((response) => (response.ok ? response.arrayBuffer() : null))
    .then((buffer) => (buffer ? new Uint8Array(buffer) : null))
    .catch(() => null)
    .then((bytes) => {
      // Not read: asked for again with the next tile.
      if (!bytes) esriMissing = null;
      return bytes;
    });
  return esriMissing;
}

const sameBytes = (a, b) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * An Esri tile, fetched. Esri's "no imagery here" picture is a missing tile,
 * drawn from its parent, as Cesium's own Esri provider discards it; a
 * refused tile is a failed one, which counts toward the Esri source's
 * fallback to OSM.
 */
async function fetchEsriTile({ url, signal }) {
  const [response, missing] = await Promise.all([
    fetch(url, { signal }),
    esriMissingTile(),
  ]);
  if (!response.ok) {
    const error = new Error(`Esri tile answered ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const bytes = await response.arrayBuffer();
  if (missing && sameBytes(new Uint8Array(bytes), missing))
    return { missing: true };
  const contentType = response.headers.get('content-type');
  return { bytes, ...(contentType ? { contentType } : {}) };
}

/** Cesium World Terrain's ion asset. */
const ION_WORLD_TERRAIN = 1;

/**
 * Ask Cesium ion for an asset's endpoint, as Cesium does before it draws
 * one: a token ion refuses, or no answer, refuses the switch with ion's
 * message, so the map stack stays where it was and says why.
 * @param {number} asset
 * @param {string} token
 * @param {AbortSignal} [signal]
 */
async function ionEndpoint(asset, token, signal) {
  const response = await fetch(
    `https://api.cesium.com/v1/assets/${asset}/endpoint?access_token=${encodeURIComponent(token)}`,
    { signal },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.message ||
        `Cesium ion answered ${response.status} for asset ${asset}`,
    );
  return body;
}

/**
 * Whether the keyless terrain answers: its `layer.json`, read as any
 * quantized-mesh terrain is read before its first tile.
 */
async function keylessTerrainAnswers(signal) {
  try {
    const response = await fetch(`${KEYLESS_TERRAIN_URL}/layer.json`, {
      signal,
    });
    return response.ok;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

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
  /** Whether this switch failed to show the base; false once it is off. */
  const failed = (error) => {
    if (handle.switches !== switchId || released.has(handle)) return false;
    console.warn('[MapStack] photoreal switch failed', error);
    if (!shown) return false;
    handle.shown = false;
    handle.globe.setGlobeVisible(true);
    shownGlobes.set(handle.globe, true);
    return true;
  };
  handle.pending = handle.globe
    .setPhotoreal(shown ? handle.spec : null)
    .then(
      (status) =>
        shown && status?.route === 'none'
          ? (status.error?.message ?? 'photoreal unavailable')
          : null,
      (error) => error ?? 'photoreal unavailable',
    )
    .then((error) => {
      if (error === null || !failed(error)) return;
      throw error instanceof Error ? error : new Error(String(error));
    });
  // A failure nobody waits for is reported above, not unhandled.
  handle.pending.catch(() => {});
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
        maxLevel: OSM_MAX_LEVEL,
        credit: credit(OSM_CREDIT),
      }),
    esri: () =>
      Object.freeze({
        kind: 'xyz',
        url: ESRI_TILES,
        tiling: 'webMercator',
        maxLevel: ESRI_MAX_LEVEL,
        fetchTile: fetchEsriTile,
        credit: credit(ESRI_IMAGERY_CREDIT),
      }),
    async ion(style, accessToken, { signal } = {}) {
      const token = String(accessToken || '').trim();
      if (!token) throw new Error('Ion imagery requires an explicit token');
      const endpoint = await ionEndpoint(style, token, signal);
      if (endpoint?.type !== 'IMAGERY' || endpoint.externalType !== 'BING')
        throw new Error(
          'Ion world imagery did not return a Bing imagery endpoint',
        );
      return Object.freeze({
        kind: 'world',
        worldStyle: WORLD_STYLES[style] ?? 'aerial',
      });
    },
  }),
  terrain: Object.freeze({
    world: async (accessToken, { signal } = {}) => {
      const token = String(accessToken || '').trim();
      if (!token)
        throw new Error('World terrain requires an explicit ion token');
      await ionEndpoint(ION_WORLD_TERRAIN, token, signal);
      return {
        provider: null,
        spec: { kind: 'world', requestVertexNormals: true },
      };
    },
    /**
     * Re:Earth's keyless terrain. While it does not answer, the ellipsoid
     * stands in as a fallback the map stack tries the terrain again behind.
     */
    keyless: async ({ signal } = {}) => {
      if (await keylessTerrainAnswers(signal))
        return {
          provider: null,
          spec: { kind: 'quantizedMesh', url: KEYLESS_TERRAIN_URL },
        };
      console.warn(
        '[MapStack] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain',
      );
      return { provider: null, spec: { kind: 'ellipsoid' }, fallback: true };
    },
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
  /**
   * Settles once `handle`'s last switch has: rejects when showing it failed
   * (the base is off again and the globe shown), so the map stack falls
   * back as from any failed switch.
   */
  tilesetReady: (handle) => handle?.pending ?? null,
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
    // Where the renderer draws no terrain, the ellipsoid stays.
    const spec = result.spec ?? null;
    const flat =
      spec?.kind !== 'ellipsoid' &&
      rendererOf(host)?.capabilities?.has('terrain') === false;
    findGlobe(host)
      ?.setTerrain(flat ? null : spec)
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
  /**
   * Never use `value` again: a photoreal handle is hidden, and an imagery
   * spec a source made with a `destroy` of its own (a source that keeps
   * tokens for its layer, say) is told, as Cesium's engine destroys a
   * provider.
   */
  release(value) {
    if (!value || typeof value !== 'object' || released.has(value)) return;
    if (value.globe && value.spec) applyPhotoreal(value, false);
    released.add(value);
    if (typeof value.destroy === 'function' && !value.isDestroyed?.())
      value.destroy();
  },
  loadPhotoreal,
});
