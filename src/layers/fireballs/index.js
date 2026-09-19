import * as Cesium from 'cesium';
import {
  FIREBALL_OVERLAY_SOURCE_ID,
  FIREBALL_OVERLAY_COHORT_LIMIT,
  FIREBALL_OVERLAY_COLLISION_CAPACITY,
  FIREBALL_MAX_AGE_MS,
  energyColor,
  createFireballOverlayEntry,
  selectFireballOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createFireballSource } from './source.js';

// Bolides span orders of magnitude in energy; a fixed minimum keeps a
// sub-kiloton event visible at globe scale while log-scaling still lets a
// Chelyabinsk-class event read as dramatically larger.
function markerRadiusMeters(impactKt) {
  const kt = Math.max(Number(impactKt) || 0, 0.001);
  return Cesium.Math.clamp(18000 * Math.log10(kt * 1000 + 10), 12000, 260000);
}

/** Own one fireball display and its refresh lifecycle. */
export function createFireballsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fireballs require a snapshot source');
  if (!overlayHost) throw new TypeError('Fireballs require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'fireballs',
    name: 'Fireballs (Recent)',
    icon: '☄️',
    source: 'NASA/JPL',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Fireballs layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('fireballs');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(FIREBALL_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Fireballs] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // Static geometry, same as earthquakes — no per-frame animator to hold
      // the render loop open for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(FIREBALL_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(FIREBALL_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIREBALL_OVERLAY_SOURCE_ID, false);
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

        const cutoffMs = Date.now() - FIREBALL_MAX_AGE_MS;
        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          lat,
          lon,
          timeMs,
          energyE10J,
          impactEnergyKt,
          altitudeKm,
          velocityKmS,
        } of rows) {
          if (timeMs != null && timeMs < cutoffMs) continue;
          count++;
          const radius = markerRadiusMeters(impactEnergyKt);
          const color = energyColor(impactEnergyKt);
          const isSignificant = (impactEnergyKt || 0) >= 1;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `fireball:${stableId}`,
              position,
              ellipse: {
                // Static axes, matching the earthquake layer: a
                // CallbackProperty here would re-tessellate every frame for
                // geometry that never moves.
                semiMajorAxis: radius,
                semiMinorAxis: radius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              point: {
                pixelSize: isSignificant ? 10 : 7,
                color,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                // Analyst seam (additive).
                impactEnergyKt,
                energyE10J,
                altitudeKm,
                velocityKmS,
                time: timeMs,
              },
            }),
          );
          overlayEntries.push(
            createFireballOverlayEntry({
              id: String(stableId),
              position,
              impactKt: impactEnergyKt,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            FIREBALL_OVERLAY_SOURCE_ID,
            selectFireballOverlayCohort(overlayEntries),
            {
              cohortLimit: FIREBALL_OVERLAY_COHORT_LIMIT,
              collisionCapacity: FIREBALL_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:Fireballs] Updated: ${_count} events`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Fireballs] Fetch error:', e);
        _lastError = e?.message || 'Fireball source unavailable';
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
      overlayHost.clearSource(FIREBALL_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIREBALL_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory fireball records as plain JSON-safe
     * objects for the analyst query engine. On-demand only, zero per-frame
     * cost. Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000]
     */
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
              id: entity.id,
              impactKt: p?.impactEnergyKt?.getValue(now),
              energyE10J: p?.energyE10J?.getValue(now),
              altKm: p?.altitudeKm?.getValue(now),
              velKmS: p?.velocityKmS?.getValue(now),
              timeMs: p?.time?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
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
