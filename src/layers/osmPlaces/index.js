import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import { msg } from '../../i18n/marker.js';
import { OSM_PLACES_LAYER_ID } from './model.js';
import { createNominatimStatus } from '../../sources/nominatimStatus.js';
export * from './model.js';

const OVERLAY_SOURCE_ID = OSM_PLACES_LAYER_ID;
/** Named results that get a map label; the rest are points. */
const LABEL_LIMIT = 48;
const COLOR = '#7fe3ff';
const OUTLINE = [0, 0, 0, 0.8];

/** Each layer's draw set id is its own. */
let instances = 0;

/**
 * OSM Places: the results of the last voice OpenStreetMap search ("hospitals
 * in Kathmandu"), drawn as points (a draw set on the viewer's renderer) with
 * name labels and queryable by
 * analyst_query. It fetches nothing itself; `setResults` replaces the set.
 * The search runs only on an operator-configured Overpass, so without one
 * the layer stays empty. Session-only: never in share links or stored layer
 * state.
 * @param {{overlayHost: object, overpassConfigured?: () => Promise<boolean|null>}} options
 */
export function createOsmPlacesLayer({
  overlayHost,
  // The same once-per-page capability probe as Nominatim's, on Overpass.
  overpassConfigured = createNominatimStatus({ url: '/api/overpass/status' }),
} = {}) {
  if (!overlayHost) throw new TypeError('OSM Places requires an overlay host');
  let viewer = null;
  /** The places' points, or null before `init` and after `destroy`. */
  let points = null;
  let enabled = false;
  let records = [];
  let meta = null;
  let lastUpdate = null;
  /** true / false from the server's probe, null while unknown. */
  let configured = null;

  function render() {
    if (!points) return;
    const items = [];
    const overlay = [];
    for (const record of records) {
      items.push({
        id: `osm-place:${record.id}`,
        pos: { lon: record.lon, lat: record.lat },
        height: 'clampGround',
        pixelSize: 9,
        color: COLOR,
        outlineColor: OUTLINE,
        outlineWidth: 2,
        // On top only up close (as bikeshare stations): beyond that the
        // depth test keeps far-side points from showing through the globe.
        disableDepthTest: 2500,
      });
      if (record.name && overlay.length < LABEL_LIMIT)
        overlay.push({
          id: record.id,
          position: fromDegrees(record.lon, record.lat),
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
    points.set(items);
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

    /** Unavailable only once the server says no Overpass is configured. */
    getSourceAvailability() {
      return configured === false
        ? {
            available: false,
            source: OSM_PLACES_LAYER_ID,
            reason: 'Needs an operator-configured Overpass server',
          }
        : { available: true, source: OSM_PLACES_LAYER_ID, reason: null };
    },

    init(nextViewer) {
      viewer = nextViewer;
      Promise.resolve(overpassConfigured?.())
        .then((answer) => {
          if (typeof answer === 'boolean') configured = answer;
        })
        .catch(() => {});
      points?.dispose();
      points = drawOf(viewer).points({
        id: `${OSM_PLACES_LAYER_ID}:${++instances}:points`,
        show: false,
      });
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (points) points.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      render();
      return true;
    },

    disable() {
      enabled = false;
      if (points) points.show = false;
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
      points?.dispose();
      points = null;
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
          : msg('Voice place search (needs an Overpass server)'),
      };
    },
  };
}
