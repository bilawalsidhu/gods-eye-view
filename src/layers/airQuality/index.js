import * as Cesium from 'cesium';
import {
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  aqiColor,
  createAirQualityOverlayEntry,
  selectAirQualityOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createAirQualitySource } from './source.js';

/**
 * Own one Air Quality display and its refresh lifecycle.
 */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    throw new TypeError('Air Quality requires a snapshot source');
  }
  if (!overlayHost) {
    throw new TypeError('Air Quality requires an overlay host');
  }

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'air-quality',
    name: 'Air Quality & Emissions',
    icon: '🌫',
    source: 'OpenAQ / Copernicus',
    updateInterval: 900000, // 15 minutes

    init(viewer) {
      if (_viewer) throw new Error('Air Quality layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('air-quality');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AirQuality] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;

      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const row of rows) {
          const {
            stableId,
            name,
            city,
            country,
            industrialType,
            lat,
            lon,
            aqi,
            category,
            primaryPollutant,
            pm25,
            pm10,
            no2,
            so2,
            timestamp,
          } = row;

          count++;
          const color = aqiColor(aqi);
          const isHighAqi = aqi > 100;
          const radiusMeters = Math.max(
            12000,
            Math.min(60000, 10000 + aqi * 120),
          );
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);

          nextEntities.push(
            new Cesium.Entity({
              id: `air-quality:${stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusMeters,
                semiMinorAxis: radiusMeters,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(isHighAqi ? 0.35 : 0.22),
                ),
                outline: true,
                outlineColor: color.withAlpha(isHighAqi ? 0.9 : 0.7),
                outlineWidth: isHighAqi ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              point: {
                pixelSize: isHighAqi ? 10 : 7,
                color,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                stationId: stableId,
                name,
                city,
                country,
                industrialType,
                aqi,
                category,
                primaryPollutant,
                pm25,
                pm10,
                no2,
                so2,
                timestamp,
              },
            }),
          );

          overlayEntries.push(
            createAirQualityOverlayEntry({
              id: String(stableId),
              position,
              name,
              aqi,
              pollutant: primaryPollutant,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

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

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:AirQuality] Updated: ${_count} monitoring stations`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }
        console.warn('[Data:AirQuality] Fetch error:', e);
        _lastError = e?.message || 'Air Quality source unavailable';
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
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];

      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;

        result.push(
          mapAnalystRecord(
            {
              id: p?.stationId?.getValue(now) ?? null,
              name: p?.name?.getValue(now) ?? null,
              city: p?.city?.getValue(now) ?? null,
              country: p?.country?.getValue(now) ?? null,
              industrialType: p?.industrialType?.getValue(now) ?? null,
              aqi: p?.aqi?.getValue(now) ?? null,
              category: p?.category?.getValue(now) ?? null,
              primaryPollutant: p?.primaryPollutant?.getValue(now) ?? null,
              pm25: p?.pm25?.getValue(now) ?? null,
              pm10: p?.pm10?.getValue(now) ?? null,
              no2: p?.no2?.getValue(now) ?? null,
              so2: p?.so2?.getValue(now) ?? null,
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
              time: p?.timestamp?.getValue(now) ?? null,
            },
            result.length,
          ),
        );
      }
      return result;
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
