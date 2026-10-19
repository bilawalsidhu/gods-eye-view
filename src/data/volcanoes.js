import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { msg } from '../i18n/index.js';

/**
 * Live volcano alerts from USGS's HANS (Hazard Alert Notification System).
 * The feed only covers USGS-monitored volcanoes (Alaska, Hawaii, Cascades,
 * Yellowstone, California, the Mariana Islands) and — unlike the earthquake
 * or FIRMS feeds — never returns coordinates, only a volcano name. Matched
 * here against a fixed lookup of the ~40 volcanoes those observatories
 * monitor; an alert for a name outside that list is skipped (logged once),
 * not fabricated a position.
 */
const API_URL = '/api/volcano-alerts';
const REFRESH_INTERVAL_MS = 900_000;

/** USGS-monitored volcano coordinates, by the exact name HANS reports. */
export const VOLCANO_COORDS = Object.freeze({
  // Alaska Volcano Observatory
  'Great Sitkin': { lat: 52.0765, lon: -176.1109 },
  'Shishaldin': { lat: 54.7554, lon: -163.9711 },
  'Pavlof': { lat: 55.4173, lon: -161.8937 },
  'Cleveland': { lat: 52.8222, lon: -169.945 },
  'Semisopochnoi': { lat: 51.9295, lon: 179.5977 },
  'Spurr': { lat: 61.2989, lon: -152.2539 },
  'Redoubt': { lat: 60.4852, lon: -152.7438 },
  'Iliamna': { lat: 60.0319, lon: -153.09 },
  'Augustine': { lat: 59.3626, lon: -153.435 },
  'Veniaminof': { lat: 56.1979, lon: -159.3931 },
  'Makushin': { lat: 53.8894, lon: -166.9298 },
  'Korovin': { lat: 52.3811, lon: -174.1547 },
  'Okmok': { lat: 53.397, lon: -168.132 },
  'Trident': { lat: 58.2343, lon: -155.1026 },
  'Katmai': { lat: 58.279, lon: -154.9533 },
  'Novarupta': { lat: 58.27, lon: -155.1567 },
  'Kanaga': { lat: 51.9242, lon: -177.1623 },
  'Gareloi': { lat: 51.7897, lon: 178.7935 },
  'Mount Kupreanof': { lat: 56.0126, lon: -159.7912 },
  'Wrangell': { lat: 62.0069, lon: -144.0192 },
  'Westdahl': { lat: 54.5171, lon: -164.6476 },
  'Akutan': { lat: 54.1341, lon: -165.9856 },
  // Hawaiian Volcano Observatory
  'Kilauea': { lat: 19.421, lon: -155.287 },
  'Mauna Loa': { lat: 19.475, lon: -155.608 },
  'Hualalai': { lat: 19.692, lon: -155.868 },
  'Loihi': { lat: 18.92, lon: -155.27 },
  // Cascades Volcano Observatory
  'Mount St. Helens': { lat: 46.1912, lon: -122.1944 },
  'Mount Rainier': { lat: 46.8523, lon: -121.7603 },
  'Mount Hood': { lat: 45.3736, lon: -121.696 },
  'Mount Baker': { lat: 48.7767, lon: -121.8144 },
  'Mount Shasta': { lat: 41.4092, lon: -122.1949 },
  'Lassen Peak': { lat: 40.4977, lon: -121.5108 },
  'Three Sisters': { lat: 44.1654, lon: -121.769 },
  'Crater Lake': { lat: 42.9446, lon: -122.109 },
  'Glacier Peak': { lat: 48.1122, lon: -121.1138 },
  'Newberry': { lat: 43.722, lon: -121.2298 },
  // Yellowstone Volcano Observatory
  'Yellowstone': { lat: 44.428, lon: -110.5885 },
  // California Volcano Observatory
  'Long Valley Caldera': { lat: 37.7, lon: -118.87 },
  'Clear Lake Volcanic Field': { lat: 38.9, lon: -122.77 },
  'Salton Buttes': { lat: 33.2, lon: -115.62 },
  // Commonwealth of the Northern Mariana Islands
  'Anatahan': { lat: 16.35, lon: 145.6667 },
  'Pagan': { lat: 18.13, lon: 145.8 },
  'Ahyi Seamount': { lat: 20.42, lon: 145.03 },
});

const COLOR_CODES = {
  GREEN: Cesium.Color.fromCssColorString('#00e400'),
  YELLOW: Cesium.Color.fromCssColorString('#ffff00'),
  ORANGE: Cesium.Color.fromCssColorString('#ff7e00'),
  RED: Cesium.Color.fromCssColorString('#ff0000'),
};

function colorFor(code) {
  return COLOR_CODES[String(code || '').toUpperCase()] || Cesium.Color.GRAY;
}

export function createVolcanoesLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _error = null;
  const _warnedUnknown = new Set();

  async function refresh() {
    try {
      const response = await fetch(API_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`USGS HANS HTTP ${response.status}`);
      const alerts = await response.json();
      if (!Array.isArray(alerts)) {
        throw new Error('Malformed USGS HANS response');
      }

      const nextEntities = [];
      let count = 0;
      for (const alert of alerts) {
        const name = alert?.volcano_name;
        const coords = VOLCANO_COORDS[name];
        if (!coords) {
          if (name && !_warnedUnknown.has(name)) {
            _warnedUnknown.add(name);
            console.warn(`[Data:Volcanoes] No known coordinates for "${name}" — skipped`);
          }
          continue;
        }
        const color = colorFor(alert.color_code);
        count++;
        nextEntities.push(new Cesium.Entity({
          id: `volcano:${name}`,
          position: Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat),
          point: {
            pixelSize: 14,
            color: color.withAlpha(0.85),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `${name} · ${alert.alert_level || alert.color_code || ''}`,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            volcano: name,
            alertLevel: alert.alert_level || null,
            colorCode: alert.color_code || null,
            observatory: alert.obs_fullname || null,
            sentUtc: alert.sent_utc || null,
            noticeUrl: alert.notice_url || null,
          },
        }));
      }

      _dataSource.entities.removeAll();
      for (const entity of nextEntities) _dataSource.entities.add(entity);
      _count = count;
      _lastUpdate = Date.now();
      _error = null;
      governorRequestRender('volcanoes-refresh');
      console.log(`[Data:Volcanoes] Updated: ${_count} elevated volcanoes`);
      return true;
    } catch (err) {
      console.warn('[Data:Volcanoes] Fetch error:', err);
      _error = err instanceof TypeError ? msg('USGS HANS network error') : err.message;
      return false;
    }
  }

  return {
    id: 'volcanoes',
    name: 'Volcanic Activity',
    icon: '🌋',
    source: 'USGS HANS',
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('volcanoes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _lastUpdate = null;
      _error = null;
      console.log('[Data:Volcanoes] Initialized');
    },

    async enable(viewer) {
      _enabled = true;
      _viewer = viewer;
      if (_dataSource) _dataSource.show = true;
      governorRequestRender('volcanoes-enable');
      if (!_lastUpdate) await refresh();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('volcanoes-disable');
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

const volcanoesLayer = createVolcanoesLayer();

export default volcanoesLayer;
