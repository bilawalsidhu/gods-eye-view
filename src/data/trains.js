import * as Cesium from 'cesium';

/**
 * Dutch trains (NS and the regional operators), positioned from stop-time
 * predictions.
 *
 * THE POSITIONS ARE MODELLED, NOT OBSERVED. The open Dutch train feed carries
 * 2,982 trip updates and not one coordinate, so each train is interpolated
 * along a straight line between the two stations it is between. Between
 * Amsterdam and Utrecht that reads as the track; through a river bend it
 * visibly does not. The layer says so on every selection card rather than
 * letting the globe imply a precision the feed does not have.
 *
 * A train standing at a platform is drawn at the platform: the dwell between
 * arriving and departing is the one time interpolation would put it a carriage
 * short of the station for minutes at a stretch.
 */

const API_URL = '/api/trains/nl';
const MAX_VIEWPORT_DEGREES = 6;
const REQUEST_TIMEOUT_MS = 20000;

const MOVING_COLOR = Cesium.Color.fromCssColorString('#ffd400');
const DWELL_COLOR = Cesium.Color.fromCssColorString('#7fd4ff');
const LATE_COLOR = Cesium.Color.fromCssColorString('#ff6b3d');
/** Late enough that a passenger would notice; below this the colour is noise. */
const LATE_THRESHOLD_SEC = 180;

/**
 * @param {?number} delaySec
 * @param {boolean} dwelling
 * @returns {Cesium.Color}
 */
export function trainColor(delaySec, dwelling) {
  if (Number.isFinite(delaySec) && delaySec >= LATE_THRESHOLD_SEC) return LATE_COLOR;
  return dwelling ? DWELL_COLOR : MOVING_COLOR;
}

/**
 * Selection text for one train.
 * @param {object} train
 * @returns {string}
 */
export function describeTrain(train) {
  const leg = `${train.fromName || '?'} → ${train.toName || '?'}`;
  const where = train.dwelling
    ? `staat op ${train.fromName || 'het perron'}`
    : `${Math.round((train.fraction || 0) * 100)}% onderweg`;
  const late = Number.isFinite(train.delaySec) && train.delaySec >= 60
    ? `, ${Math.round(train.delaySec / 60)} min vertraging`
    : (Number.isFinite(train.delaySec) && train.delaySec > 0 ? `, ${train.delaySec}s vertraging` : ', op tijd');
  return `${leg} — ${where}${late} · positie geschat tussen de stations, niet op het spoor`;
}

export function createTrainsLayer() {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastError = null;
  let _lastUpdate = null;

  const layer = {
    id: 'trains-nl',
    name: 'Trains (NL)',
    icon: '🚆',
    source: 'NDOV / OVapi',
    updateInterval: 20000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('trains-nl');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _count = 0;
      console.log('[Data:Trains] Initialized');
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
      const rectangle = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
      let query = '';
      if (rectangle) {
        const south = Cesium.Math.toDegrees(rectangle.south);
        const north = Cesium.Math.toDegrees(rectangle.north);
        const west = Cesium.Math.toDegrees(rectangle.west);
        const east = Cesium.Math.toDegrees(rectangle.east);
        // A national view is legitimate here — the whole country is 293 trains —
        // so only an absurd rectangle falls back to asking for everything.
        if (Number.isFinite(south + north + west + east) && east > west && north > south
          && north - south <= MAX_VIEWPORT_DEGREES && east - west <= MAX_VIEWPORT_DEGREES) {
          query = `?bbox=${[south, west, north, east].map((n) => n.toFixed(4)).join(',')}`;
        }
      }

      let payload;
      try {
        const response = await fetch(`${API_URL}${query}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
      } catch (error) {
        // Keep the last good picture: OVapi throttles, and a layer that blanks
        // on every 429 flickers its way through a busy session.
        _lastError = error?.message || String(error);
        return;
      }
      _lastError = null;
      _lastUpdate = payload?.at || null;

      const entities = _dataSource.entities;
      entities.suspendEvents();
      entities.removeAll();
      for (const train of payload?.trains || []) {
        if (!Number.isFinite(train?.lat) || !Number.isFinite(train?.lon)) continue;
        entities.add({
          id: `train-${train.tripId}`,
          position: Cesium.Cartesian3.fromDegrees(train.lon, train.lat, 30),
          point: {
            pixelSize: train.dwelling ? 8 : 10,
            color: trainColor(train.delaySec, train.dwelling).withAlpha(0.95),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          name: `${train.fromName || '?'} → ${train.toName || '?'}`,
          description: describeTrain(train),
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

const trainsLayer = createTrainsLayer();

export default trainsLayer;
