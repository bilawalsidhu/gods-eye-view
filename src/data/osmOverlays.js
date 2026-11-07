import { NO_IMAGERY_HOST } from '../maps/imageryHost.js';
// The application's renderer gives the globe port; a viewer with no
// renderer bound gets one from the factory its Cesium side loads.
import { findGlobe } from '../render/rendererOf.js';

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
 * Each overlay is an imagery layer of the renderer's globe port, draped on
 * whatever is drawn: the globe on the OSM and Bing stacks, the Google
 * Photorealistic tiles on Google 3D. The map stack's own record says which
 * (`getDrapeSurface`); only a stack with neither leaves them hidden, and the
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

/** The imagery spec of one overlay. */
export function osmOverlaySpec(overlay) {
  return {
    kind: 'xyz',
    url: overlay.urlTemplate,
    maxLevel: overlay.maximumLevel,
    credit: { text: overlay.credit },
  };
}

/**
 * Create the layer for one overlay descriptor. Each application catalog gets
 * its own instances; `globeOf` (the viewer's globe port) is injectable so
 * tests run without WebGL.
 */
export function createOsmOverlayLayer(overlay, { globeOf = findGlobe } = {}) {
  if (!OSM_OVERLAYS.includes(overlay))
    throw new TypeError(`Unknown open map overlay: ${overlay?.id}`);
  let viewer = null;
  let mapStack = null;
  let unsubscribeMap = null;
  let enabled = false;
  let surface = 'none';
  /** The imagery layer this instance owns while enabled. */
  let owned = null;

  /**
   * What the overlay drapes on: the map stack's record, or with no map
   * stack, whether the viewer's globe is shown.
   */
  function drapeSurface() {
    const recorded = mapStack?.getDrapeSurface?.();
    if (recorded) return recorded;
    return viewer?.scene?.globe?.show === true ? 'globe' : 'none';
  }

  /** Add or remove the owned imagery layer to match the state. */
  function sync() {
    if (!viewer) return;
    surface = enabled ? drapeSurface() : 'none';
    if (!enabled) {
      owned?.remove();
      owned = null;
    } else if (!owned) {
      // Added last, so it draws above the map stack's base imagery.
      owned = globeOf(viewer)?.imagery.add(osmOverlaySpec(overlay)) ?? null;
    }
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
    /** Follow map-stack switches, for the row's hidden reason. */
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
      if (enabled && !unsubscribeMap) surface = drapeSurface();
      // No globe port yet (a viewer whose renderer came later): try again.
      if (enabled && !owned) sync();
      return {
        count: enabled ? 1 : 0,
        error: osmOverlayHiddenReason(enabled, surface),
      };
    },
    /** Owned layer count and drape surface, for tests and live gates. */
    diagnostics() {
      return { host: surface, ownedCount: owned ? 1 : 0 };
    },
    destroy() {
      enabled = false;
      owned?.remove();
      owned = null;
      unsubscribeMap?.();
      unsubscribeMap = null;
      mapStack = null;
      viewer = null;
      surface = 'none';
    },
  };
}

/** One layer per overlay, in panel order. */
export function createOsmOverlayLayers(options) {
  return OSM_OVERLAYS.map((overlay) => createOsmOverlayLayer(overlay, options));
}
