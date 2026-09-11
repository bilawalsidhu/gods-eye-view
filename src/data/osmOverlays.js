import * as Cesium from 'cesium';

/**
 * @file Open-data raster overlays drawn on the Cesium GLOBE surface —
 * OpenSeaMap sea marks and OpenSnowMap ski pistes (#10). Two independently
 * toggleable overlays sharing one config-driven module, same "small array of
 * descriptors" shape as `MAP_STACKS` in mapStackController.js.
 *
 * OpenRailwayMap and OpenInfraMap, also named in #10, are deliberately NOT
 * included in this pass:
 *  - OpenRailwayMap's public tile server (tiles.openrailwaymap.org) enforces
 *    a Referer allowlist scoped to openrailwaymap.org itself — verified by
 *    direct request: a Referer of `https://www.openrailwaymap.org/` returns
 *    the tile, every other Referer (including none) returns 403, regardless
 *    of User-Agent. A browser tab on this app sends ITS OWN origin as
 *    Referer, so the tiles would 403 in practice, and embedding them here
 *    would run against their stated tile-usage policy either way
 *    (CONTRIBUTING.md: "Don't add scraping of sources whose terms forbid it").
 *  - OpenInfraMap serves MapLibre GL vector tiles (MVT) from its own
 *    infrastructure, not simple raster XYZ tiles — adding it means a genuine
 *    vector-tile rendering pipeline, not a `Cesium.ImageryLayer` drop-in.
 *    Worth its own dedicated pass; out of scope here.
 *
 * Like every non-photoreal-stack raster source, these overlays draw on the
 * Cesium globe (`viewer.scene.globe`), not on the Google Photorealistic 3D
 * Tiles mesh (see `mapStackController.js`: the photoreal stack renders with
 * `globe.show = false`, and a hidden globe requests and draws no imagery).
 * They're visible on the `osm`/`bing-aerial`/`bing-labels` map stacks and
 * invisible — not broken, just nothing to draw on — on the default
 * `photoreal` stack. `getStats().error` surfaces that in plain language
 * whenever an enabled overlay is currently showing nothing for this reason.
 * @module data/osmOverlays
 */

export const OSM_OVERLAYS_LAYER_ID = 'osm-overlays';

/** @type {Array<{key:string,label:string,icon:string,urlTemplate:string,credit:string,maximumLevel:number}>} */
export const OSM_OVERLAYS = Object.freeze([
  Object.freeze({
    key: 'seamap',
    label: 'Sea Marks',
    icon: '⚓',
    // Confirmed live 2026-08-25: https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png
    urlTemplate: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    credit: '© OpenSeaMap contributors',
    maximumLevel: 18,
  }),
  Object.freeze({
    key: 'snowmap',
    label: 'Ski Pistes',
    icon: '⛷',
    // Confirmed live 2026-08-25: https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png
    urlTemplate: 'https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png',
    credit: 'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenSnowMap.org (CC-BY-SA)',
    maximumLevel: 18,
  }),
]);

const DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(OSM_OVERLAYS.map((overlay) => [overlay.key, true])),
);

/** Reason an enabled, chosen overlay is currently showing nothing, or null. */
export function osmOverlaysHiddenReason(enabled, params, globeShown) {
  if (!enabled) return null;
  const anyChosen = OSM_OVERLAYS.some((overlay) => Boolean(params?.[overlay.key]));
  if (!anyChosen) return null;
  if (globeShown) return null;
  return 'Overlays draw on the globe surface — switch the map stack to OSM or Bing (not Google 3D) to see them';
}

/**
 * Sanitize a candidate params object against the two known overlay keys.
 * Unknown keys are ignored; a non-boolean value for a known key leaves that
 * key's current value untouched rather than coercing it (mirrors the
 * `undefined` = "not requested" convention `satellites.js`/`radio.js` use).
 * @param {object} current — the module's live `{seamap, snowmap}` state
 * @param {object} candidate
 * @returns {{next: object, changed: boolean}}
 */
export function applyOsmOverlayParams(current, candidate = {}) {
  const next = { ...current };
  let changed = false;
  for (const overlay of OSM_OVERLAYS) {
    if (!Object.hasOwn(candidate, overlay.key)) continue;
    const value = candidate[overlay.key];
    if (typeof value !== 'boolean') continue;
    if (next[overlay.key] !== value) changed = true;
    next[overlay.key] = value;
  }
  return { next, changed };
}

const state = {
  viewer: null,
  enabled: false,
  params: { ...DEFAULT_PARAMS },
  imageryLayers: new Map(),
};

function syncImageryLayerVisibility() {
  for (const overlay of OSM_OVERLAYS) {
    const layer = state.imageryLayers.get(overlay.key);
    if (layer) layer.show = state.enabled && Boolean(state.params[overlay.key]);
  }
}

const osmOverlaysLayer = {
  id: OSM_OVERLAYS_LAYER_ID,
  name: 'Open Map Overlays',
  icon: '🗺️',
  source: 'OpenSeaMap / OpenSnowMap',
  updateInterval: 0,
  init(viewer) {
    state.viewer = viewer;
    for (const overlay of OSM_OVERLAYS) {
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: overlay.urlTemplate,
        credit: overlay.credit,
        maximumLevel: overlay.maximumLevel,
      });
      const layer = new Cesium.ImageryLayer(provider);
      layer.show = false;
      // Appended (no index) so it draws on top of the base map-stack imagery
      // layer mapStackController.js keeps at index 0.
      viewer.imageryLayers.add(layer);
      state.imageryLayers.set(overlay.key, layer);
    }
  },
  enable() {
    state.enabled = true;
    syncImageryLayerVisibility();
  },
  disable() {
    state.enabled = false;
    syncImageryLayerVisibility();
  },
  update() {
    return true;
  },
  setParams(params = {}) {
    const { next, changed } = applyOsmOverlayParams(state.params, params);
    if (changed) {
      state.params = next;
      syncImageryLayerVisibility();
    }
    return true;
  },
  getParams() {
    return { ...state.params };
  },
  getRowControls() {
    if (!state.enabled) return { chips: [], legend: [] };
    const globeShown = state.viewer?.scene?.globe?.show !== false;
    return {
      chips: OSM_OVERLAYS.map((overlay) => {
        const active = Boolean(state.params[overlay.key]);
        return {
          id: overlay.key,
          label: `${overlay.icon} ${overlay.label}`,
          active,
          title: globeShown
            ? overlay.credit
            : `${overlay.credit} — needs the OSM or Bing map stack to render, not Google 3D`,
          params: { [overlay.key]: !active },
        };
      }),
      legend: [],
    };
  },
  destroy(viewer) {
    this.disable();
    for (const layer of state.imageryLayers.values()) {
      if (viewer) viewer.imageryLayers.remove(layer, true);
    }
    state.imageryLayers.clear();
    state.viewer = null;
    state.params = { ...DEFAULT_PARAMS };
  },
  getStats() {
    const globeShown = state.viewer?.scene?.globe?.show !== false;
    return {
      count: state.enabled
        ? OSM_OVERLAYS.filter((overlay) => state.params[overlay.key]).length
        : 0,
      error: osmOverlaysHiddenReason(state.enabled, state.params, globeShown),
    };
  },
};

export default osmOverlaysLayer;
