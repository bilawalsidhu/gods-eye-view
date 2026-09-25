import * as Cesium from 'cesium';
import {
  AIR_QUALITY_BANDS,
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  AIR_QUALITY_PROVIDERS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export { createEcccAirQualitySource } from './source.js';

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;

/** Own one air-quality display, its refresh lifecycle, and its readout card. */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('air-quality');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const readings = await source.getSnapshot({ signal: request.signal });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _readings = readings;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || 'Air quality request failed';
        console.warn('[Data:AirQuality] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
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
            id: `air-quality:${reading.id}`,
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
              provider: reading.provider,
              scale: reading.scale,
              value: reading.value,
              band: reading.band,
              name: reading.name,
              zone: reading.zone,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          }),
        );
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            value: reading.value,
          }),
        );
      }
      if (_enabled) {
        overlayHost.setEntries(
          AIR_QUALITY_OVERLAY_SOURCE_ID,
          selectAirQualityOverlayCohort(overlayEntries),
          {
            cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, and the worst
     * readings currently in view.
     *
     * `readout: true` renders the toggle and source line only; the card owns
     * the rest. Coverage is stated plainly because this layer is not global.
     */
    getRowControls() {
      const provider = AIR_QUALITY_PROVIDERS.eccc;
      const inView = readingsInView(_readings, viewRectangle(), READOUT_LIMIT);
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      return {
        readout: true,
        summary: {
          label: provider.label,
          coverage: provider.coverage,
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: `${provider.network} · ${provider.scale}`,
          status: _lastError
            ? _lastError
            : _count === 0
              ? 'No readings available'
              : `${_count} stations reporting`,
          units: provider.scale,
        },
        legend: {
          colors: AIR_QUALITY_BANDS.map((band) => band.color),
          labels: AIR_QUALITY_BANDS.map((band) => band.label),
          units: provider.scale,
          categorical: true,
        },
        list: {
          ariaLabel: 'Highest air-quality readings in view',
          items: inView.map((reading) => ({
            id: reading.id,
            label: reading.name,
            value: `${reading.scale} ${reading.label}`,
            accent: reading.color,
            detail: reading.risk,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
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
