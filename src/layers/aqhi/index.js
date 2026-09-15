import * as Cesium from 'cesium';
import {
  AQHI_OVERLAY_SOURCE_ID,
  AQHI_OVERLAY_COHORT_LIMIT,
  AQHI_OVERLAY_COLLISION_CAPACITY,
  createAqhiOverlayEntry,
  selectAqhiOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createEcccAqhiSource } from './source.js';

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;

/** Own one Air Quality Health Index display and its refresh lifecycle. */
export function createAqhiLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('AQHI requires a snapshot source');
  if (!overlayHost) throw new TypeError('AQHI requires an overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'aqhi',
    name: 'Air Quality (AQHI)',
    icon: '◍',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,

    init(viewer) {
      if (_viewer) throw new Error('AQHI layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aqhi');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AQHI_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const readings = await source.getSnapshot();
        _readings = readings;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        _lastError = error?.message || 'AQHI request failed';
        console.warn('[Data:AQHI] Refresh failed:', _lastError);
        return false;
      }
    },

    /** Rebuild entities and overlay labels from the current readings. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const overlayEntries = [];
      for (const reading of _readings) {
        const position = Cesium.Cartesian3.fromDegrees(
          reading.lon,
          reading.lat,
        );
        const color = Cesium.Color.fromCssColorString(reading.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `aqhi:${reading.stationId}`,
            position,
            ellipse: {
              // Static axes, as in the earthquake layer: a per-frame axis
              // re-tessellates the clamped ground primitive every frame.
              semiMajorAxis: STATION_MARKER_RADIUS_M,
              semiMinorAxis: STATION_MARKER_RADIUS_M,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
            properties: {
              stationId: reading.stationId,
              name: reading.name,
              zone: reading.zone,
              aqhi: reading.aqhi,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          }),
        );
        overlayEntries.push(
          createAqhiOverlayEntry({
            id: reading.stationId,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            aqhi: reading.aqhi,
          }),
        );
      }
      if (_enabled) {
        overlayHost.setEntries(
          AQHI_OVERLAY_SOURCE_ID,
          selectAqhiOverlayCohort(overlayEntries),
          {
            cohortLimit: AQHI_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AQHI_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(AQHI_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        (viewer || _viewer)?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * The current reading nearest a point — what "the air quality here" means.
     * @param {number} lat
     * @param {number} lon
     * @returns {object|null} Reading with distanceKm, or null when none loaded.
     */
    nearestReading(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !_readings.length)
        return null;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      let best = null;
      let bestDistance = Infinity;
      for (const reading of _readings) {
        const dLat = (reading.lat - lat) * 111.32;
        const dLon = (reading.lon - lon) * 111.32 * cosLat;
        const distance = Math.hypot(dLat, dLon);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = reading;
        }
      }
      return best ? { ...best, distanceKm: bestDistance } : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
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
