import * as Cesium from 'cesium';

export { createEffisBurntAreasSource } from './source.js';
export * from './records.js';

const EARTH_RADIUS_M = 6371000;

/**
 * Planar shoelace area on an equirectangular projection centered on the
 * ring's own mean latitude — adequate for burn-scar sizes (few km across),
 * not survey-grade. Fallback only: ms:modis.ba.poly.week's AREA_HA field is
 * schema-optional (minOccurs="0"), so a feature can genuinely arrive with no
 * area — this is what fills in when that happens, not the primary source.
 */
export function computeAreaHectares(ring) {
  const meanLatRad =
    (ring.reduce((sum, [, lat]) => sum + lat, 0) / ring.length) *
    (Math.PI / 180);
  const cosLat = Math.cos(meanLatRad);
  const points = ring.map(([lon, lat]) => [
    ((lon * Math.PI) / 180) * EARTH_RADIUS_M * cosLat,
    ((lat * Math.PI) / 180) * EARTH_RADIUS_M,
  ]);
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2 / 10000;
}

/** Own one burnt-areas display and its refresh lifecycle. */
export function createBurntAreasLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Burnt areas require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'burnt-areas',
    name: 'Wildfire Burnt Areas (EFFIS)',
    icon: '🔥',
    source: 'Copernicus EFFIS',
    updateInterval: 15 * 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Burnt areas layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('burnt-areas');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        for (const { stableId, polygon, areaHa, fireDate } of rows) {
          const positions = polygon.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat),
          );
          nextEntities.push(
            new Cesium.Entity({
              id: `burnt-area:${stableId}`,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(positions),
                material: Cesium.Color.ORANGERED.withAlpha(0.45),
                outline: true,
                outlineColor: Cesium.Color.ORANGERED,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              // areaHa is the real ms:modis.ba.poly.week AREA_HA field when
              // present; computeAreaHectares only fills in the schema-optional
              // gap (minOccurs="0" — a real feature can arrive with none).
              properties: {
                areaHa: areaHa ?? computeAreaHectares(polygon),
                areaHaIsEstimate: areaHa == null,
                fireDate,
              },
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

        _count = nextEntities.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:BurntAreas] Updated: ${_count} perimeters`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:BurntAreas] Fetch error:', e);
        _lastError = e?.message || 'EFFIS source unavailable';
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
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
