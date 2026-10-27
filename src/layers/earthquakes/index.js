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
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

/**
 * Own one earthquake display and its refresh lifecycle.
 * renderer.create({viewer, engine}) owns drawing and returns:
 * setVisible(boolean), replace(discs), records(limit), destroy().
 * Discs are plain ECEF anchors, metre radii and Rgba colours; renderers keep
 * source order and return plain raw analyst rows (model.mapAnalystRecord).
 */
export function createEarthquakesLayer({ source, overlayHost, renderer } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  if (typeof renderer?.create !== 'function')
    throw new TypeError('Earthquakes require a renderer factory');
  let _viewer = null;
  let _request = null;
  let _renderer = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer, { engine = null } = {}) {
      if (_renderer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _renderer = renderer.create({ viewer, engine });
      if (!_renderer) throw new Error('Earthquake renderer unavailable');
      _renderer.setVisible(false);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      _renderer?.setVisible(true);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _renderer?.setVisible(false);
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_renderer) return false;
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

        for (const {
          stableId,
          usgsId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = geo.cartesian3.fromDegrees(lon, lat);
          nextDiscs.push({
            stableId,
            usgsId,
            position,
            baseRadius,
            color,
            isSignificant,
            fillAlpha,
            outlineAlpha,
            mag,
            place,
            time,
            depthKm,
          });
          overlayEntries.push(
            createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
            }),
          );
        }

        _renderer.replace(nextDiscs);
        if (_enabled) {
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            selectEarthquakeOverlayCohort(overlayEntries),
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
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
        _lastError = e?.message || 'Earthquake source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      _renderer?.destroy();
      _renderer = null;
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
      if (!_enabled || !_renderer) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _renderer.records(limit).map(mapAnalystRecord);
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
