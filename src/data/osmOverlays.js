import { NO_IMAGERY_HOST } from '../layers/shared/imageryHost.js';

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
 * The overlays drape through the globe engine on whatever surface the
 * active map stack offers: `engine.imagery` (on Cesium the globe on the OSM
 * and Bing stacks, the Google Photorealistic tileset's own imagery on Google
 * 3D; the engine follows stack switches), or Navara's own raster overlay
 * (`engine.maps.addOverlay`, per-tile levels on its terrain) where the
 * engine has one. Only a surface with neither leaves them hidden, and the
 * row says so.
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

// Over the heat rasters, under event imagery and the weather.
const OVERLAY_ORDER = 10;
const HOST_KIND = Object.freeze({ globe: 'globe', tiles: 'tileset' });

/**
 * Create the layer for one overlay descriptor. Each application catalog gets
 * its own instances.
 */
export function createOsmOverlayLayer(overlay) {
  if (!OSM_OVERLAYS.includes(overlay))
    throw new TypeError(`Unknown open map overlay: ${overlay?.id}`);
  let engine = null;
  let enabled = false;
  /** The drape this instance owns while enabled: an imagery layer or a removal. */
  let owned = null;

  /** Where the drape lies now: 'globe', 'tileset' or 'none'. */
  function hostKind() {
    if (!owned) return 'none';
    if (owned.remove) return 'globe';
    return HOST_KIND[engine?.imagery?.surface?.()] ?? 'none';
  }

  function release() {
    if (!owned) return;
    const { layer, remove } = owned;
    owned = null;
    if (remove) remove();
    else layer.destroy();
  }

  /** Create or drop the owned drape to match the state. */
  function sync() {
    if (!engine || !enabled) {
      release();
      return;
    }
    if (owned) return;
    const remove = engine.maps?.addOverlay?.({
      url: overlay.urlTemplate,
      maxZoom: overlay.maximumLevel,
      credit: overlay.credit,
    });
    if (typeof remove === 'function') {
      owned = { remove };
      return;
    }
    if (!engine.imagery) return;
    owned = {
      layer: engine.imagery.createLayer({
        id: `osm-overlay-${overlay.id}`,
        source: {
          kind: 'tiles',
          url: overlay.urlTemplate,
          maxLevel: overlay.maximumLevel,
          credit: overlay.credit,
        },
        order: OVERLAY_ORDER,
      }),
    };
  }

  return {
    id: overlay.id,
    name: overlay.name,
    icon: overlay.icon,
    source: overlay.source,
    updateInterval: 0,
    init(viewer, options) {
      this.attachRenderer(options);
    },
    /** Drape on a globe engine's imagery. */
    attachRenderer({ engine: nextEngine = null } = {}) {
      release();
      engine = nextEngine;
      sync();
    },
    /** Leave the globe; the enabled state stays for the next one. */
    detachRenderer() {
      release();
      engine = null;
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
      return {
        count: enabled ? 1 : 0,
        error: osmOverlayHiddenReason(enabled, hostKind()),
      };
    },
    /** Owned drape count and host kind, for tests and live gates. */
    diagnostics() {
      return { host: hostKind(), ownedCount: owned ? 1 : 0 };
    },
    destroy() {
      enabled = false;
      release();
      engine = null;
    },
  };
}

/** One layer per overlay, in panel order. */
export function createOsmOverlayLayers(options) {
  return OSM_OVERLAYS.map((overlay) => createOsmOverlayLayer(overlay, options));
}
