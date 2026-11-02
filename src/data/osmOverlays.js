import * as Cesium from 'cesium';
import { msg, t } from '../i18n/index.js';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../maps/imageryHost.js';

/**
 * @file Open-data raster overlays: OpenSeaMap sea marks and OpenSnowMap ski
 * pistes (#10). Two independently toggleable overlays sharing one
 * config-driven layer, the same "small array of descriptors" shape as the
 * map stacks.
 *
 * OpenRailwayMap and OpenInfraMap, also named in #10, are deliberately not
 * included:
 *  - OpenRailwayMap's public tile server (tiles.openrailwaymap.org) only
 *    serves requests whose Referer is openrailwaymap.org; every other Referer,
 *    including none, gets 403. A tab on this app sends its own origin, so the
 *    tiles would fail, and embedding them would run against their tile-usage
 *    policy either way.
 *  - OpenInfraMap serves MapLibre vector tiles, not raster XYZ tiles. That
 *    needs a vector-tile rendering pipeline, not an imagery-layer drop-in.
 *
 * The overlays drape on whatever surface the active map stack offers (see
 * `maps/imageryHost.js`): the globe on the OSM and Bing stacks, the Google
 * Photorealistic tileset's own `imageryLayers` on Google 3D. Only a stack with
 * neither leaves them hidden, and the row says so.
 * @module data/osmOverlays
 */

export const OSM_OVERLAYS_LAYER_ID = 'osm-overlays';

/** @type {ReadonlyArray<{key:string,label:string,icon:string,urlTemplate:string,credit:string,maximumLevel:number}>} */
export const OSM_OVERLAYS = Object.freeze([
  Object.freeze({
    key: 'seamap',
    label: msg('Sea Marks'),
    icon: '⚓',
    urlTemplate: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    // Chart tiles CC BY-SA 2.0; the underlying data is OpenStreetMap (ODbL).
    credit:
      'Sea marks © OpenSeaMap contributors (CC BY-SA 2.0) · Data © OpenStreetMap contributors (ODbL)',
    maximumLevel: 18,
  }),
  Object.freeze({
    key: 'snowmap',
    label: msg('Ski Pistes'),
    icon: '⛷',
    urlTemplate: 'https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png',
    // OpenSnowMap asks for "(c)www.opensnowmap.org" wherever its tiles appear.
    credit:
      'Ski pistes © www.opensnowmap.org (CC BY-SA) · Data © OpenStreetMap contributors (ODbL)',
    maximumLevel: 18,
  }),
]);

const DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(OSM_OVERLAYS.map((overlay) => [overlay.key, true])),
);

/**
 * Sanitize a candidate params object against the known overlay keys. Unknown
 * keys are ignored; a non-boolean value for a known key leaves that key
 * untouched rather than coercing it.
 * @param {object} current the live `{seamap, snowmap}` state
 * @param {object} candidate
 * @returns {{next: object, changed: boolean}}
 */
export function applyOsmOverlayParams(current, candidate = {}) {
  const next = { ...current };
  let changed = false;
  for (const overlay of OSM_OVERLAYS) {
    if (!Object.hasOwn(candidate ?? {}, overlay.key)) continue;
    const value = candidate[overlay.key];
    if (typeof value !== 'boolean') continue;
    if (next[overlay.key] !== value) changed = true;
    next[overlay.key] = value;
  }
  return { next, changed };
}

/** Why an enabled overlay with something chosen is showing nothing, or null. */
export function osmOverlaysHiddenReason(enabled, params, hostKind) {
  if (!enabled || hostKind !== 'none') return null;
  const anyChosen = OSM_OVERLAYS.some((overlay) =>
    Boolean(params?.[overlay.key]),
  );
  return anyChosen ? NO_IMAGERY_HOST : null;
}

/**
 * Create one Open Map Overlays layer. Each application catalog gets its own
 * instance; the Cesium factories are injectable so tests run without WebGL.
 */
export function createOsmOverlaysLayer({
  host = resolveImageryHost,
  createProvider = (overlay) =>
    new Cesium.UrlTemplateImageryProvider({
      url: overlay.urlTemplate,
      credit: overlay.credit,
      maximumLevel: overlay.maximumLevel,
    }),
  createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
} = {}) {
  let viewer = null;
  let mapStack = null;
  let unsubscribeMap = null;
  let enabled = false;
  let params = { ...DEFAULT_PARAMS };
  let hostInfo = { collection: null, kind: 'none' };
  /** Imagery layers this instance owns, by overlay key: `{ layer, collection }`. */
  const owned = new Map();

  const usable = (collection) => collection && !collection.isDestroyed?.();

  function detach(entry, destroy) {
    const { collection, layer } = entry;
    if (usable(collection) && collection.contains(layer))
      collection.remove(layer, destroy);
    else if (destroy && !layer.isDestroyed?.()) layer.destroy?.();
    entry.collection = null;
  }

  function resolveHost() {
    return (
      host({ viewer, tileset: mapStack?.getImageryHostTileset?.() }) || {
        collection: null,
        kind: 'none',
      }
    );
  }

  /** Create, move or drop owned imagery layers so they match the wanted set. */
  function sync() {
    if (!viewer) return;
    hostInfo = enabled ? resolveHost() : { collection: null, kind: 'none' };
    for (const overlay of OSM_OVERLAYS) {
      const wanted = enabled && Boolean(params[overlay.key]);
      let entry = owned.get(overlay.key);
      if (!wanted) {
        if (entry) {
          detach(entry, true);
          owned.delete(overlay.key);
        }
        continue;
      }
      if (!entry) {
        entry = {
          layer: createImageryLayer(createProvider(overlay)),
          collection: null,
        };
        owned.set(overlay.key, entry);
      }
      if (entry.collection === hostInfo.collection) continue;
      detach(entry, false);
      if (usable(hostInfo.collection)) {
        // Appended, so it draws above the map stack's base imagery.
        hostInfo.collection.add(entry.layer);
        entry.collection = hostInfo.collection;
      }
    }
    viewer.scene?.requestRender?.();
  }

  return {
    id: OSM_OVERLAYS_LAYER_ID,
    name: 'Open Map Overlays',
    icon: '🗺️',
    source: 'OpenSeaMap / OpenSnowMap',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    /** Follow map-stack switches so the drapes move with the surface. */
    attachMapStackController(controller) {
      unsubscribeMap?.();
      unsubscribeMap = null;
      mapStack = controller || null;
      const off = controller?.subscribe?.(() => {
        if (enabled) sync();
      });
      unsubscribeMap = typeof off === 'function' ? off : null;
    },
    enable() {
      enabled = true;
      sync();
    },
    disable() {
      enabled = false;
      sync();
    },
    update() {
      return true;
    },
    setParams(next = {}) {
      const result = applyOsmOverlayParams(params, next);
      if (result.changed) {
        params = result.next;
        sync();
      }
      return true;
    },
    getParams() {
      return { ...params };
    },
    getRowControls() {
      if (!enabled) return { chips: [], legend: [] };
      return {
        chips: OSM_OVERLAYS.map((overlay) => {
          const active = Boolean(params[overlay.key]);
          return {
            id: overlay.key,
            label: `${overlay.icon} ${t(overlay.label)}`,
            active,
            title: overlay.credit,
            params: { [overlay.key]: !active },
          };
        }),
        legend: [],
      };
    },
    getStats() {
      // Without a controller subscription the stats poll doubles as the
      // map-stack watch.
      if (enabled && !unsubscribeMap) {
        const next = resolveHost();
        if (next.collection !== hostInfo.collection) sync();
      }
      return {
        count: enabled
          ? OSM_OVERLAYS.filter((overlay) => params[overlay.key]).length
          : 0,
        error: osmOverlaysHiddenReason(enabled, params, hostInfo.kind),
      };
    },
    /** Owned layer count and host kind, for tests and live gates. */
    diagnostics() {
      return { host: hostInfo.kind, ownedCount: owned.size };
    },
    destroy() {
      enabled = false;
      for (const entry of owned.values()) detach(entry, true);
      owned.clear();
      unsubscribeMap?.();
      unsubscribeMap = null;
      mapStack = null;
      viewer = null;
      hostInfo = { collection: null, kind: 'none' };
      params = { ...DEFAULT_PARAMS };
    },
  };
}
