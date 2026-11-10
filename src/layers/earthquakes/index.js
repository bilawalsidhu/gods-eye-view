import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
// Source errors stay English until the layer panel presents them.
const msg = (text) => text;
import * as geo from '../../geo/index.js';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
import { createEarthquakesDisplay } from './render/display.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

/**
 * Own one earthquake display and its refresh lifecycle.
 * rendererFactory({ engine }) owns drawing (render/display.js by default)
 * and returns: setVisible(boolean), replace(discs), destroy().
 * Discs are degrees, metre radii and Rgba colours; renderers keep source
 * order. The layer retains observations for queries while detached.
 */
export function createEarthquakesLayer({
  source,
  overlayHost,
  rendererFactory = ({ engine }) => createEarthquakesDisplay(engine),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  if (typeof rendererFactory !== 'function')
    throw new TypeError('Earthquakes require a renderer factory');
  let sceneEngine = null;
  overlayHost = bindOverlayHost(overlayHost, () => sceneEngine);
  let initialized = false;
  let observations = [];
  let discs = [];
  let labels = [];
  let _request = null;
  let _renderer = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  function publishLabels() {
    overlayHost.setEntries(EARTHQUAKE_OVERLAY_SOURCE_ID, labels, {
      cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
      collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer, { engine = null } = {}) {
      if (initialized)
        throw new Error('Earthquake layer is already initialized');
      initialized = true;
      try {
        if (engine) this.attachRenderer({ engine });
      } catch (error) {
        this.destroy();
        throw error;
      }
      console.log('[Data:Earthquakes] Initialized');
    },

    show(enabled) {
      _renderer?.setVisible(enabled);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, enabled);
    },
    attachRenderer({ engine = null } = {}) {
      if (!initialized || _renderer)
        throw new Error('Invalid earthquake scene attachment');
      sceneEngine = engine;
      _renderer = rendererFactory({ engine });
      if (!_renderer) throw new Error('Earthquake renderer unavailable');
      this.show(_enabled);
      if (discs.length) _renderer.replace(discs);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, _enabled);
      if (_enabled) publishLabels();
    },

    detachRenderer() {
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      _renderer?.destroy();
      _renderer = null;
      sceneEngine = null;
    },

    enable() {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      _renderer?.setVisible(true);
      if (_renderer) {
        overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
        if (labels.length) publishLabels();
      }
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _renderer?.setVisible(false);
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextDiscs = [];
        let count = 0;
        const overlayEntries = [];

        for (const { stableId, lon, lat, depthKm, mag } of rows) {
          count++;
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const fillAlpha = mag >= 5.0 ? 0.4 : 0.3;

          const position = geo.cartesian3.fromDegrees(lon, lat);
          nextDiscs.push({ stableId, lon, lat, baseRadius, color, fillAlpha });
          overlayEntries.push(
            createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
            }),
          );
        }

        observations = rows;
        discs = nextDiscs;
        labels = selectEarthquakeOverlayCohort(overlayEntries);
        if (_renderer) {
          _renderer.replace(discs);
          publishLabels();
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Earthquakes] Updated: ${_count} events (M2.5+)`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || msg('Earthquake source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      initialized = false;
      _enabled = false;
      this.detachRenderer();
      observations = [];
      discs = [];
      labels = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return observations
        .slice(0, limit)
        .map((row, index) =>
          mapAnalystRecord(
            { ...row, id: row.usgsId, depth: row.depthKm },
            index,
          ),
        );
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
