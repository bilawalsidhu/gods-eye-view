import * as Cesium from 'cesium';
import { NDW_SPEED_BANDS } from './ndwGantries.js';

/**
 * Live Dutch road speeds (NDW) — one point per gantry, coloured by its
 * slowest lane.
 *
 * Viewport-bounded on purpose. The national picture is 12,297 gantries and
 * the body that produces it is 53 MB of DATEX II every minute; all of that
 * work happens in the proxy, and the browser is handed the few hundred rows
 * it is looking at.
 *
 * The colour is the SLOWEST lane at the mast, never the average. A blocked
 * lane beside a free one is what a jam is — measured on the Van
 * Brienenoordbrug at 16:37, one direction ran 102 km/h while the other sat at
 * 39 with 8,400 vehicles an hour behind it. An average would paint that green.
 */

const API_URL = '/api/ndw/traffic';
/** Above this the view is regional and the request would return the cap anyway. */
const MAX_VIEWPORT_DEGREES = 2.5;
const REQUEST_TIMEOUT_MS = 20000;

const BAND_COLOR = Object.freeze({
  jam: Cesium.Color.fromCssColorString('#ff2d2d'),
  slow: Cesium.Color.fromCssColorString('#ff8c00'),
  busy: Cesium.Color.fromCssColorString('#ffd400'),
  flowing: Cesium.Color.fromCssColorString('#35d07f'),
});
const BAND_LABEL = Object.freeze(
  Object.fromEntries(NDW_SPEED_BANDS.map((b) => [b.id, b.label])),
);

/**
 * The camera's ground footprint as a plain box, or null when the view is too
 * wide to bound a request with.
 * @param {object} viewer
 * @returns {?{south:number, west:number, north:number, east:number}}
 */
export function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (!Number.isFinite(south + north + west + east)) return null;
  if (east <= west || north <= south) return null;
  if (north - south > MAX_VIEWPORT_DEGREES || east - west > MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

/**
 * Point size for a gantry: busier masts read larger, so a jam on a trunk road
 * is not the same dot as a jam on a side street.
 * @param {number} flowVph
 * @returns {number}
 */
export function pointSize(flowVph) {
  if (!Number.isFinite(flowVph) || flowVph <= 0) return 7;
  return Math.max(7, Math.min(16, 7 + Math.round(flowVph / 900)));
}

/**
 * Human description for the selection card.
 * @param {object} gantry
 * @returns {string}
 */
export function describeGantry(gantry) {
  const name = gantry.name || 'Rijkswaterstaat meetpunt';
  const lanes = gantry.sensors === 1 ? '1 sensor' : `${gantry.sensors} sensoren`;
  const spread = gantry.fastestKph > gantry.slowestKph
    ? ` (snelste strook ${gantry.fastestKph} km/h)`
    : '';
  const flow = Number.isFinite(gantry.flowVph) && gantry.flowVph > 0
    ? `${gantry.flowVph} voertuigen/uur` : 'intensiteit onbekend';
  return `${name} — ${gantry.slowestKph} km/h${spread}, ${flow}, ${lanes} · ${BAND_LABEL[gantry.band] || ''}`;
}

export function createNdwTrafficLayer() {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastError = null;
  let _lastUpdate = null;

  const layer = {
    id: 'ndw-traffic',
    name: 'Road speeds (NL)',
    icon: '🚦',
    source: 'NDW',
    updateInterval: 60000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('ndw-traffic');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _count = 0;
      console.log('[Data:NDW] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      _count = 0;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return;
      const box = viewportBox(viewer);
      if (!box) {
        // Too wide to ask about: clear rather than leave a stale regional
        // picture pinned under a globe view.
        _dataSource.entities.removeAll();
        _count = 0;
        return;
      }
      const bbox = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(4)).join(',');
      let payload;
      try {
        const response = await fetch(`${API_URL}?bbox=${bbox}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
      } catch (error) {
        // A failed poll leaves the previous points in place: stale speeds for
        // one minute beat a layer that blinks out whenever a feed hiccups.
        _lastError = error?.message || String(error);
        return;
      }
      _lastError = null;
      _lastUpdate = payload?.at || null;

      const entities = _dataSource.entities;
      entities.suspendEvents();
      entities.removeAll();
      for (const gantry of payload?.gantries || []) {
        if (!Number.isFinite(gantry?.lat) || !Number.isFinite(gantry?.lon)) continue;
        const color = BAND_COLOR[gantry.band] || BAND_COLOR.flowing;
        entities.add({
          id: `ndw-${gantry.key}`,
          position: Cesium.Cartesian3.fromDegrees(gantry.lon, gantry.lat),
          point: {
            pixelSize: pointSize(gantry.flowVph),
            color: color.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          name: gantry.name || 'NDW meetpunt',
          description: describeGantry(gantry),
        });
      }
      entities.resumeEvents();
      _count = entities.values.length;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };

  return layer;
}

const ndwTrafficLayer = createNdwTrafficLayer();

export default ndwTrafficLayer;
