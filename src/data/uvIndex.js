import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { msg, t } from '../i18n/index.js';

/**
 * Live UV Index at a fixed set of major world cities.
 * Open-Meteo's forecast API is point-based (no global raster), so this
 * samples a curated city list in one batched request rather than gridding
 * the whole globe — a grid would mostly land on ocean with no data.
 */
const API_URL = '/api/uv-index';
const REFRESH_INTERVAL_MS = 900_000;

/** Curated set of major population centers spanning every inhabited continent. */
const AQI_CITIES = Object.freeze([
  { name: 'Austin', lat: 30.2672, lon: -97.7431 },
  { name: 'New York', lat: 40.7128, lon: -74.006 },
  { name: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'Houston', lat: 29.7604, lon: -95.3698 },
  { name: 'Mexico City', lat: 19.4326, lon: -99.1332 },
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333 },
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816 },
  { name: 'Bogotá', lat: 4.711, lon: -74.0721 },
  { name: 'Lima', lat: -12.0464, lon: -77.0428 },
  { name: 'Santiago', lat: -33.4489, lon: -70.6693 },
  { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { name: 'Berlin', lat: 52.52, lon: 13.405 },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { name: 'Rome', lat: 41.9028, lon: 12.4964 },
  { name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
  { name: 'Moscow', lat: 55.7558, lon: 37.6173 },
  { name: 'Istanbul', lat: 41.0082, lon: 28.9784 },
  { name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { name: 'Lagos', lat: 6.5244, lon: 3.3792 },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219 },
  { name: 'Johannesburg', lat: -26.2041, lon: 28.0473 },
  { name: 'Kinshasa', lat: -4.4419, lon: 15.2663 },
  { name: 'Dubai', lat: 25.2048, lon: 55.2708 },
  { name: 'Riyadh', lat: 24.7136, lon: 46.6753 },
  { name: 'Tehran', lat: 35.6892, lon: 51.389 },
  { name: 'Karachi', lat: 24.8607, lon: 67.0011 },
  { name: 'New Delhi', lat: 28.6139, lon: 77.209 },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777 },
  { name: 'Dhaka', lat: 23.8103, lon: 90.4125 },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018 },
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456 },
  { name: 'Manila', lat: 14.5995, lon: 120.9842 },
  { name: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { name: 'Beijing', lat: 39.9042, lon: 116.4074 },
  { name: 'Shanghai', lat: 31.2304, lon: 121.4737 },
  { name: 'Hong Kong', lat: 22.3193, lon: 114.1694 },
  { name: 'Seoul', lat: 37.5665, lon: 126.978 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { name: 'Auckland', lat: -36.8485, lon: 174.7633 },
]);

const UV_LEVELS = [
  { max: 2, color: Cesium.Color.fromCssColorString('#00e400'), label: msg('LOW') },
  { max: 5, color: Cesium.Color.fromCssColorString('#ffff00'), label: msg('MODERATE') },
  { max: 7, color: Cesium.Color.fromCssColorString('#ff7e00'), label: msg('HIGH') },
  { max: 10, color: Cesium.Color.fromCssColorString('#ff0000'), label: msg('VERY HIGH') },
  { max: Infinity, color: Cesium.Color.fromCssColorString('#8f3f97'), label: msg('EXTREME') },
];

export function uvLevel(uv) {
  return UV_LEVELS.find((level) => uv <= level.max) || UV_LEVELS[UV_LEVELS.length - 1];
}

function buildQueryString() {
  const lats = AQI_CITIES.map((c) => c.lat).join(',');
  const lons = AQI_CITIES.map((c) => c.lon).join(',');
  return `latitude=${lats}&longitude=${lons}&current=uv_index`;
}

const QUERY_STRING = buildQueryString();

export function createUvIndexLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _error = null;

  async function refresh() {
    try {
      const response = await fetch(`${API_URL}?${QUERY_STRING}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
      const results = await response.json();
      if (!Array.isArray(results) || results.length !== AQI_CITIES.length) {
        throw new Error('Malformed Open-Meteo response');
      }

      const nextEntities = [];
      let count = 0;
      for (let i = 0; i < AQI_CITIES.length; i++) {
        const city = AQI_CITIES[i];
        const uv = results[i]?.current?.uv_index;
        if (!Number.isFinite(uv)) continue;
        const level = uvLevel(uv);
        // Only surface cities with meaningful daytime UV — plotting every
        // city at "0 · LOW" through the night side is just clutter.
        if (uv <= 0) continue;
        const radius = 30000 + Math.min(uv, 12) * 6000;
        count++;
        nextEntities.push(new Cesium.Entity({
          id: `uv:${city.name}`,
          position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat),
          ellipse: {
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            material: new Cesium.ColorMaterialProperty(level.color.withAlpha(0.3)),
            outline: true,
            outlineColor: level.color.withAlpha(0.9),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          label: {
            text: `${city.name} · ${t('UV {value}', { value: uv.toFixed(1) })}`,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -8),
            scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 1.2e7, 0.4),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { uv, level: level.label },
        }));
      }

      _dataSource.entities.removeAll();
      for (const entity of nextEntities) _dataSource.entities.add(entity);
      _count = count;
      _lastUpdate = Date.now();
      _error = null;
      governorRequestRender('uv-index-refresh');
      console.log(`[Data:UvIndex] Updated: ${_count} cities with daytime UV`);
      return true;
    } catch (err) {
      console.warn('[Data:UvIndex] Fetch error:', err);
      _error = err instanceof TypeError ? msg('Open-Meteo network error') : err.message;
      return false;
    }
  }

  return {
    id: 'uv-index',
    name: 'UV Index',
    icon: '☀️',
    source: 'Open-Meteo',
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('uv-index');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _lastUpdate = null;
      _error = null;
      console.log('[Data:UvIndex] Initialized');
    },

    async enable(viewer) {
      _enabled = true;
      _viewer = viewer;
      if (_dataSource) _dataSource.show = true;
      governorRequestRender('uv-index-enable');
      if (!_lastUpdate) await refresh();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('uv-index-disable');
    },

    async update() {
      if (!_enabled) return false;
      return refresh();
    },

    destroy(viewer) {
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _error = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _error };
    },
  };
}

const uvIndexLayer = createUvIndexLayer();

export default uvIndexLayer;
