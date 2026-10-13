import * as Cesium from 'cesium';
import {
  LAYER_ID,
  LAYER_NAME,
  LAYER_SOURCE,
  ENTITY_PREFIX,
  TELEMETRY_OVERLAY_SOURCE_ID,
  TELEMETRY_OVERLAY_COHORT_LIMIT,
  TELEMETRY_OVERLAY_COLLISION_CAPACITY,
} from './policy.js';
import {
  statusColor,
  typeIcon,
  typeLabel,
  createTelemetryOverlayEntry,
  selectTelemetryOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './policy.js';
export * from './model.js';
export { createLocalTelemetrySource } from './source.js';

/**
 * Own one Industrial Telemetry layer and its real-time refresh lifecycle.
 */
export function createLocalTelemetryLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    throw new TypeError('Industrial Telemetry requires a snapshot source');
  }
  if (!overlayHost) {
    throw new TypeError('Industrial Telemetry requires an overlay host');
  }

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _rawDevices = [];

  const layer = {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '⟐',
    source: LAYER_SOURCE,
    updateInterval: 3000, // 3 seconds fast industrial telemetry poller

    init(viewer) {
      if (_viewer) {
        throw new Error('Industrial Telemetry layer is already initialized');
      }
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _rawDevices = [];
      overlayHost.setVisible(TELEMETRY_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Telemetry] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(TELEMETRY_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(TELEMETRY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TELEMETRY_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;

      try {
        const devices = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }

        _rawDevices = devices;
        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const device of devices) {
          const { id, name, type, lat, lon, alt, status, heading, battery } =
            device;
          const hex = statusColor(status);
          const color = Cesium.Color.fromCssColorString(hex);
          const isHighAlert = status === 'fault';
          const isWarning = status === 'warning';
          const isAirborne = type === 'drone';

          count++;
          const position = isAirborne
            ? Cesium.Cartesian3.fromDegrees(lon, lat, alt || 60)
            : Cesium.Cartesian3.fromDegrees(lon, lat, 0);

          nextEntities.push(
            new Cesium.Entity({
              id: `${ENTITY_PREFIX}${id}`,
              name: `${typeIcon(type)} ${name}`,
              position,
              // Cyber pulsing ground disc / halo
              ellipse: {
                semiMinorAxis: isHighAlert ? 60.0 : isWarning ? 45.0 : 35.0,
                semiMajorAxis: isHighAlert ? 60.0 : isWarning ? 45.0 : 35.0,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(isHighAlert ? 0.45 : 0.25),
                ),
                outline: true,
                outlineColor: color.withAlpha(isHighAlert ? 0.95 : 0.75),
                outlineWidth: isHighAlert ? 3 : 2,
                heightReference: isAirborne
                  ? Cesium.HeightReference.NONE
                  : Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              point: {
                pixelSize: isHighAlert ? 12 : 9,
                color,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                heightReference: isAirborne
                  ? Cesium.HeightReference.NONE
                  : Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                deviceId: id,
                name,
                type,
                facility: device.facility,
                status,
                battery,
                heading,
                speed: device.speed,
                metrics: device.metrics,
                rawDevice: device,
              },
            }),
          );

          const overlayItem = createTelemetryOverlayEntry(device);
          if (overlayItem) overlayEntries.push(overlayItem);
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

        if (_enabled) {
          overlayHost.setEntries(
            TELEMETRY_OVERLAY_SOURCE_ID,
            selectTelemetryOverlayCohort(
              overlayEntries,
              TELEMETRY_OVERLAY_COHORT_LIMIT,
            ),
            {
              cohortLimit: TELEMETRY_OVERLAY_COHORT_LIMIT,
              collisionCapacity: TELEMETRY_OVERLAY_COLLISION_CAPACITY,
              moving: true,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Telemetry] Updated: ${_count} industrial machines`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }
        console.warn('[Data:Telemetry] Fetch error:', e);
        _lastError = e?.message || 'Telemetry source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _rawDevices = [];
      if (_dataSource && viewer?.dataSources) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _viewer = null;
      overlayHost.clearSource(TELEMETRY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TELEMETRY_OVERLAY_SOURCE_ID, false);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords() {
      return _rawDevices.map((d) => mapAnalystRecord(d)).filter(Boolean);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
        enabled: _enabled,
      };
    },
  };

  return layer;
}
