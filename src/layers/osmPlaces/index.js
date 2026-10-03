import * as Cesium from 'cesium';
import { OSM_PLACES_LAYER_ID } from './model.js';
export * from './model.js';

const OVERLAY_SOURCE_ID = OSM_PLACES_LAYER_ID;
/** Named results that get a map label; the rest are points. */
const LABEL_LIMIT = 48;
const COLOR = '#7fe3ff';

/**
 * OSM Places: the results of the last voice OpenStreetMap search ("hospitals
 * in Kathmandu"), drawn as points with name labels and queryable by
 * analyst_query. It fetches nothing itself; `setResults` replaces the set.
 * The search runs only on an operator-configured Overpass, so without one
 * the layer stays empty. Session-only: never in share links or stored layer
 * state.
 * @param {{overlayHost: object}} options
 */
export function createOsmPlacesLayer({ overlayHost } = {}) {
  if (!overlayHost) throw new TypeError('OSM Places requires an overlay host');
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let records = [];
  let meta = null;
  let lastUpdate = null;

  function render() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    const color = Cesium.Color.fromCssColorString(COLOR);
    const overlay = [];
    for (const record of records) {
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      dataSource.entities.add({
        id: `osm-place:${record.id}`,
        position,
        point: {
          pixelSize: 9,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      if (record.name && overlay.length < LABEL_LIMIT)
        overlay.push({
          id: record.id,
          position,
          variant: 'label',
          title: record.name.slice(0, 40),
          accent: COLOR,
          priority: LABEL_LIMIT - overlay.length,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 12,
          verticalOnly: true,
          placement: 'above',
        });
    }
    if (enabled)
      overlayHost.setEntries(OVERLAY_SOURCE_ID, overlay, {
        cohortLimit: LABEL_LIMIT,
        collisionCapacity: LABEL_LIMIT,
        moving: false,
      });
  }

  return {
    id: OSM_PLACES_LAYER_ID,
    name: 'OSM Places',
    icon: '⌖',
    source: 'OpenStreetMap',
    updateInterval: 0,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(OSM_PLACES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      render();
      return true;
    },

    disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      return true;
    },

    /** Nothing to poll: results change only through setResults. */
    async update() {
      return true;
    },

    destroy() {
      enabled = false;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (dataSource && viewer) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      records = [];
      meta = null;
      lastUpdate = null;
    },

    /**
     * Replace the result set.
     * @param {object[]} next Records from `mapOsmFeature`.
     * @param {{kind: string, label: string, area: string}} nextMeta
     */
    setResults(next, nextMeta) {
      records = Array.isArray(next) ? next.slice() : [];
      meta = nextMeta ? { ...nextMeta } : null;
      lastUpdate = Date.now();
      render();
    },

    /** The current search, for panels and voice. */
    getResultsMeta() {
      return meta ? { ...meta, count: records.length } : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return records.slice(0, limit).map((record) => ({ ...record }));
    },

    getStats() {
      return {
        count: records.length,
        lastUpdate,
        error: null,
        statusMessage: meta
          ? `${meta.label} · ${meta.area}`
          : 'Voice place search (needs an Overpass server)',
      };
    },
  };
}
