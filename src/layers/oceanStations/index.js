import * as Cesium from 'cesium';
import {
  OCEAN_STATION_OVERLAY_SOURCE_ID,
  buildOceanStationCard,
} from './cards.js';
import { stationColor, mapAnalystRecord } from './model.js';

export * from './cards.js';
export * from './model.js';
export { createOceanStationsSource } from './source.js';
export {
  normalizeOceanStationSnapshot,
  parseNdbcLatestObs,
} from './records.js';

const PICK_PREFIX = 'ocean-station:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/**
 * Owns NOAA NDBC Ocean Stations display and refresh lifecycle.
 */
export function createOceanStationsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    throw new TypeError('Ocean stations require a snapshot source');
  }

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, Object>} */
  const _stationsById = new Map();

  function publishSelectedCard() {
    if (!overlayHost) return;
    const station = _selectedId ? _stationsById.get(_selectedId) : null;
    if (!station) {
      _selectedId = null;
      overlayHost.setEntries(
        OCEAN_STATION_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }

    const card = {
      ...buildOceanStationCard(station, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat, 0),
    };

    if (card.interactive && card.link && openExternal) {
      const link = card.link;
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }

    overlayHost.setEntries(
      OCEAN_STATION_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function resolvePickedStationId(picked) {
    if (!picked) return null;
    let entityId = null;
    if (typeof picking?.resolvePickId === 'function') {
      entityId = picking.resolvePickId(picked);
    } else if (typeof picked?.id === 'string') {
      entityId = picked.id;
    } else if (typeof picked?.id?.id === 'string') {
      entityId = picked.id.id;
    }
    if (typeof entityId === 'string' && entityId.startsWith(PICK_PREFIX)) {
      const id = entityId.slice(PICK_PREFIX.length);
      return _stationsById.has(id) ? id : null;
    }
    return null;
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    const canvas = _viewer.scene?.canvas;
    if (!canvas) return;

    const handler =
      typeof screenSpaceEventHandlerFactory === 'function'
        ? screenSpaceEventHandlerFactory(_viewer)
        : new Cesium.ScreenSpaceEventHandler(canvas);

    _clickHandler = handler;
    handler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;

      const cardHit = overlayHost?.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: OCEAN_STATION_OVERLAY_SOURCE_ID },
      );
      if (cardHit) {
        if (_selectedId && openExternal) {
          const stn = _stationsById.get(_selectedId);
          if (stn) {
            const card = buildOceanStationCard(stn, Date.now());
            if (card.link) openExternal(card.link);
          }
        }
        return;
      }

      const picked = _viewer.scene?.pick?.(click.position);
      const stnId = resolvePickedStationId(picked);

      if (stnId) {
        _selectedId = stnId;
        publishSelectedCard();
      } else if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  const layer = {
    id: 'ocean-stations',
    name: 'Ocean Stations (NDBC)',
    icon: '🌊',
    source: 'NOAA NDBC',
    updateInterval: 300_000, // 5 minutes

    init(viewer) {
      if (_viewer)
        throw new Error('Ocean stations layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('ocean-stations');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _selectedId = null;
      _stationsById.clear();
      overlayHost?.setVisible(OCEAN_STATION_OVERLAY_SOURCE_ID, false);
      installClickHandler();
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(OCEAN_STATION_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      _selectedId = null;
      overlayHost?.clearSource(OCEAN_STATION_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible(OCEAN_STATION_OVERLAY_SOURCE_ID, false);
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

        _stationsById.clear();
        const nextEntities = [];

        for (const station of rows) {
          _stationsById.set(station.id, station);
          const color = stationColor(station);
          const position = Cesium.Cartesian3.fromDegrees(
            station.lon,
            station.lat,
            0,
          );

          nextEntities.push(
            new Cesium.Entity({
              id: `${PICK_PREFIX}${station.id}`,
              position,
              point: {
                pixelSize: 8,
                color,
                outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
                outlineWidth: 1.5,
                scaleByDistance: new Cesium.NearFarScalar(
                  1000,
                  1.2,
                  5_000_000,
                  0.6,
                ),
                translucencyByDistance: new Cesium.NearFarScalar(
                  1000,
                  1.0,
                  10_000_000,
                  0.4,
                ),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: station,
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) {
          _dataSource.entities.add(entity);
        }

        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;

        if (_selectedId) {
          publishSelectedCard();
        }

        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled) {
          return false;
        }
        _lastError = e?.message || 'Ocean stations unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _selectedId = null;
      _stationsById.clear();
      overlayHost?.clearSource(OCEAN_STATION_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible(OCEAN_STATION_OVERLAY_SOURCE_ID, false);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot layer records as JSON-safe analyst records for voice queries.
     * @param {number} [maxCount=2000]
     * @returns {Array<Object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      const now = Cesium.JulianDate.now();

      for (const entity of entities) {
        if (result.length >= limit) break;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.id?.getValue(now),
              lat: p?.lat?.getValue(now),
              lon: p?.lon?.getValue(now),
              waveHeightM: p?.waveHeightM?.getValue(now),
              wavePeriodSec: p?.wavePeriodSec?.getValue(now),
              waterTempC: p?.waterTempC?.getValue(now),
              airTempC: p?.airTempC?.getValue(now),
              windSpeedMps: p?.windSpeedMps?.getValue(now),
              windDirDeg: p?.windDirDeg?.getValue(now),
              pressureHpa: p?.pressureHpa?.getValue(now),
              timeMs: p?.timeMs?.getValue(now),
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
