import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  depthAccent,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/**
 * The draw sets the discs are drawn in start with this; each layer has its
 * own (`earthquakes:1`, …), so several can share a renderer. Picks name it
 * as `Hit.set`.
 */
export const EARTHQUAKE_DISC_SET_ID = 'earthquakes';
let instances = 0;

/**
 * Own one earthquake display and its refresh lifecycle.
 *
 * The discs are one renderer draw set (`drawOf(viewer)`), made at `init`.
 * Given a Cesium viewer with no renderer bound, the
 * caller loads the package's `./render/cesium/unbound` export first.
 */
export function createEarthquakesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _discs = null;
  // What the discs were drawn from, so analyst reads come from the app, not the drawing.
  let _events = [];
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

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _discs = drawOf(viewer).shapes({
        id: `${EARTHQUAKE_DISC_SET_ID}:${++instances}`,
        show: false,
      });
      _viewer = viewer;
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
      if (_discs) _discs.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_discs) _discs.show = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_discs) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextDiscs = [];
        const nextEvents = [];
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
          const [r, g, b] = color;
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;

          const position = fromDegrees(lon, lat);
          nextEvents.push({ usgsId, mag, place, time, depthKm, lon, lat });
          // A filled disc on the ground, with static axes: re-tessellating
          // clamped ground geometry every frame is what once cost 30 fps.
          // No outline: clamped to the ground, Cesium never drew one.
          nextDiscs.push({
            id: `earthquake:${stableId}`,
            geometry: {
              kind: 'ellipse',
              center: { lon, lat },
              semiMajor: baseRadius,
              semiMinor: baseRadius,
            },
            fill: [r, g, b, fillAlpha],
            height: 'clampGround',
            clampTo: 'both',
          });
          overlayEntries.push(
            createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: depthAccent(depthKm || 0),
            }),
          );
        }

        _discs.set(nextDiscs);
        _events = nextEvents;
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
        _lastError = e?.message || msg('Earthquake source unavailable');
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
      _discs?.dispose();
      _discs = null;
      _events = [];
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
      if (!_discs || !_enabled || !_events.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return _events.slice(0, limit).map((event, index) =>
        mapAnalystRecord(
          {
            id: event.usgsId ?? null,
            mag: event.mag,
            place: event.place,
            time: event.time,
            depth: event.depthKm,
            lat: event.lat,
            lon: event.lon,
          },
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
