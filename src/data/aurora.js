import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { msg } from '../i18n/index.js';

/**
 * NOAA SWPC's OVATION aurora forecast: a ~1° global grid of aurora
 * probability/intensity (0-16). Rendered as small colored points — the raw
 * feed is 32,000+ cells, almost all zero away from the poles, so only cells
 * clearing a visibility threshold are drawn, capped to the strongest N.
 */
const API_URL = '/api/aurora';
const REFRESH_INTERVAL_MS = 600_000;
/** Below this the aurora oval is not realistically visible — pure noise floor. */
const MIN_VISIBLE_INTENSITY = 4;
/** Hard cap so a geomagnetic-storm night (much wider oval) stays cheap to render. */
const MAX_POINTS = 4000;

function intensityColor(value) {
  // NOAA's own scale tops out near 16; a green→yellow→red ramp reads as
  // "aurora glow" at low-moderate values and "storm" at the high end.
  const t = Math.min(1, value / 16);
  if (t < 0.5) return Cesium.Color.LIME.withAlpha(0.15 + t * 0.5);
  if (t < 0.8) return Cesium.Color.YELLOW.withAlpha(0.35 + (t - 0.5) * 0.6);
  return Cesium.Color.RED.withAlpha(0.5 + (t - 0.8) * 0.5);
}

export function createAuroraLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _error = null;
  let _forecastTime = null;

  async function refresh() {
    try {
      const response = await fetch(API_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`NOAA SWPC HTTP ${response.status}`);
      const payload = await response.json();
      const coords = payload?.coordinates;
      if (!Array.isArray(coords) || !coords.length) {
        throw new Error('Malformed NOAA SWPC response');
      }

      const visible = [];
      for (const entry of coords) {
        const [lon, lat, value] = Array.isArray(entry) ? entry : [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(value)) continue;
        if (value < MIN_VISIBLE_INTENSITY) continue;
        visible.push({ lon, lat, value });
      }
      visible.sort((a, b) => b.value - a.value);
      const capped = visible.slice(0, MAX_POINTS);

      const nextEntities = capped.map(({ lon, lat, value }, i) => new Cesium.Entity({
        id: `aurora:${i}`,
        // NOAA's grid uses 0-360° longitude; Cesium wants -180..180.
        position: Cesium.Cartesian3.fromDegrees(lon > 180 ? lon - 360 : lon, lat),
        point: {
          pixelSize: 6 + Math.min(value, 16) * 0.8,
          color: intensityColor(value),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { intensity: value },
      }));

      _dataSource.entities.removeAll();
      for (const entity of nextEntities) _dataSource.entities.add(entity);
      _count = nextEntities.length;
      _forecastTime = payload['Forecast Time'] || null;
      _lastUpdate = Date.now();
      _error = null;
      governorRequestRender('aurora-refresh');
      console.log(`[Data:Aurora] Updated: ${_count} cells above threshold`);
      return true;
    } catch (err) {
      console.warn('[Data:Aurora] Fetch error:', err);
      _error = err instanceof TypeError ? msg('NOAA SWPC network error') : err.message;
      return false;
    }
  }

  return {
    id: 'aurora',
    name: 'Aurora Forecast',
    icon: '🌌',
    source: 'NOAA SWPC',
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aurora');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _lastUpdate = null;
      _error = null;
      console.log('[Data:Aurora] Initialized');
    },

    async enable(viewer) {
      _enabled = true;
      _viewer = viewer;
      if (_dataSource) _dataSource.show = true;
      governorRequestRender('aurora-enable');
      if (!_lastUpdate) await refresh();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('aurora-disable');
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
      _forecastTime = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _error, forecastTime: _forecastTime };
    },
  };
}

const auroraLayer = createAuroraLayer();

export default auroraLayer;
