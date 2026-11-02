import * as Cesium from 'cesium';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../maps/imageryHost.js';

/**
 * @file Open-data raster overlays: OpenSeaMap sea marks and OpenSnowMap ski
 * pistes (#10). Each overlay is its own layer with its own row under
 * Infrastructure; both are built from the descriptors below.
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

/** @type {ReadonlyArray<{id:string,name:string,icon:string,source:string,urlTemplate:string,credit:string,maximumLevel:number}>} */
export const OSM_OVERLAYS = Object.freeze([
  Object.freeze({
    id: 'sea-marks',
    name: 'Sea Marks',
    icon: '⚓',
    source: 'OpenSeaMap',
    urlTemplate: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    // Chart tiles CC BY-SA 2.0; the underlying data is OpenStreetMap (ODbL).
    credit:
      'Sea marks © OpenSeaMap contributors (CC BY-SA 2.0) · Data © OpenStreetMap contributors (ODbL)',
    maximumLevel: 18,
  }),
  Object.freeze({
    id: 'ski-pistes',
    name: 'Ski Pistes',
    icon: '⛷',
    source: 'OpenSnowMap',
    urlTemplate: 'https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png',
    // OpenSnowMap asks for "(c)www.opensnowmap.org" wherever its tiles appear.
    credit:
      'Ski pistes © www.opensnowmap.org (CC BY-SA) · Data © OpenStreetMap contributors (ODbL)',
    maximumLevel: 18,
  }),
]);

/** Why an enabled overlay is showing nothing, or null. */
export function osmOverlayHiddenReason(enabled, hostKind) {
  return enabled && hostKind === 'none' ? NO_IMAGERY_HOST : null;
}

/**
 * Create the layer for one overlay descriptor. Each application catalog gets
 * its own instances; the Cesium factories are injectable so tests run without
 * WebGL.
 */
export function createOsmOverlayLayer(
  overlay,
  {
    host = resolveImageryHost,
    createProvider = (descriptor) =>
      new Cesium.UrlTemplateImageryProvider({
        url: descriptor.urlTemplate,
        credit: descriptor.credit,
        maximumLevel: descriptor.maximumLevel,
      }),
    createImageryLayer = (provider) => new Cesium.ImageryLayer(provider),
  } = {},
) {
  if (!OSM_OVERLAYS.includes(overlay))
    throw new TypeError(`Unknown open map overlay: ${overlay?.id}`);
  let viewer = null;
  let mapStack = null;
  let unsubscribeMap = null;
  let enabled = false;
  let hostInfo = { collection: null, kind: 'none' };
  /** The imagery layer this instance owns while enabled, and where it sits. */
  let owned = null;

  const usable = (collection) => collection && !collection.isDestroyed?.();

  function detach(destroy) {
    if (!owned) return;
    const { collection, layer } = owned;
    if (usable(collection) && collection.contains(layer))
      collection.remove(layer, destroy);
    else if (destroy && !layer.isDestroyed?.()) layer.destroy?.();
    owned.collection = null;
    if (destroy) owned = null;
  }

  function resolveHost() {
    return (
      host({ viewer, tileset: mapStack?.getImageryHostTileset?.() }) || {
        collection: null,
        kind: 'none',
      }
    );
  }

  /** Create, move or drop the owned imagery layer to match the state. */
  function sync() {
    if (!viewer) return;
    hostInfo = enabled ? resolveHost() : { collection: null, kind: 'none' };
    if (!enabled) {
      detach(true);
    } else {
      owned ||= {
        layer: createImageryLayer(createProvider(overlay)),
        collection: null,
      };
      if (owned.collection !== hostInfo.collection) {
        detach(false);
        if (usable(hostInfo.collection)) {
          // Appended, so it draws above the map stack's base imagery.
          hostInfo.collection.add(owned.layer);
          owned.collection = hostInfo.collection;
        }
      }
    }
    viewer.scene?.requestRender?.();
  }

  return {
    id: overlay.id,
    name: overlay.name,
    icon: overlay.icon,
    source: overlay.source,
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    /** Follow map-stack switches so the drape moves with the surface. */
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
    getStats() {
      // Without a controller subscription the stats poll doubles as the
      // map-stack watch.
      if (enabled && !unsubscribeMap) {
        const next = resolveHost();
        if (next.collection !== hostInfo.collection) sync();
      }
      return {
        count: enabled ? 1 : 0,
        error: osmOverlayHiddenReason(enabled, hostInfo.kind),
      };
    },
    /** Owned layer count and host kind, for tests and live gates. */
    diagnostics() {
      return { host: hostInfo.kind, ownedCount: owned ? 1 : 0 };
    },
    destroy() {
      enabled = false;
      detach(true);
      unsubscribeMap?.();
      unsubscribeMap = null;
      mapStack = null;
      viewer = null;
      hostInfo = { collection: null, kind: 'none' };
    },
  };
}

/** One layer per overlay, in panel order. */
export function createOsmOverlayLayers(options) {
  return OSM_OVERLAYS.map((overlay) => createOsmOverlayLayer(overlay, options));
}
