import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import * as geo from '../../geo/index.js';
import { msg } from '../../i18n/marker.js';
import { OSM_PLACES_LAYER_ID, OSM_PLACE_COLOR } from './model.js';
import { createNominatimStatus } from '../../sources/nominatimStatus.js';
import { createOsmPlacesDisplay } from './render/display.js';
export * from './model.js';

const OVERLAY_SOURCE_ID = OSM_PLACES_LAYER_ID;
/** Named results that get a map label; the rest are points. */
const LABEL_LIMIT = 48;
const COLOR = OSM_PLACE_COLOR;

/**
 * OSM Places: the results of the last voice OpenStreetMap search ("hospitals
 * in Kathmandu"), drawn as points with name labels and queryable by
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
  createRenderer = ({ engine }) => createOsmPlacesDisplay(engine),
} = {}) {
  if (!overlayHost) throw new TypeError('OSM Places requires an overlay host');
  let sceneEngine = null;
  overlayHost = bindOverlayHost(overlayHost, () => sceneEngine);
  let initialized = false;
  let renderer = null;
  let enabled = false;
  let records = [];
  let meta = null;
  let lastUpdate = null;
  /** true / false from the server's probe, null while unknown. */
  let configured = null;

  function render() {
    if (!renderer) return;
    renderer.replace(records);
    const overlay = [];
    for (const record of records) {
      if (!record.name || overlay.length >= LABEL_LIMIT) continue;
      overlay.push({
        id: record.id,
        position: geo.cartesian3.fromDegrees(record.lon, record.lat),
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

    init(viewer, { engine = null } = {}) {
      if (initialized) return;
      initialized = true;
      Promise.resolve(overpassConfigured?.())
        .then((answer) => {
          if (typeof answer === 'boolean') configured = answer;
        })
        .catch(() => {});
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      if (engine) this.attachRenderer({ engine });
    },

    /** Draw on a globe; the results stay for the next one. */
    show(enabled) {
      renderer?.setVisible(enabled);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, enabled);
    },
    attachRenderer({ engine = null } = {}) {
      if (!initialized || renderer)
        throw new Error('Invalid OSM Places scene attachment');
      sceneEngine = engine;
      renderer = createRenderer({ engine });
      this.show(enabled);
      if (enabled) overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      render();
    },

    detachRenderer() {
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      renderer?.destroy();
      renderer = null;
      sceneEngine = null;
    },

    enable() {
      enabled = true;
      renderer?.setVisible(true);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      render();
      return true;
    },

    disable() {
      enabled = false;
      renderer?.setVisible(false);
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
      this.detachRenderer();
      initialized = false;
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
