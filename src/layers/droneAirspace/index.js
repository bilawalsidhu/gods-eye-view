import * as Cesium from 'cesium';
import {
  DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
  droneAirspaceAnchorDegrees,
  buildDroneAirspaceCard,
  droneAirspaceAccent,
} from './cards.js';
export { normalizeDroneAirspaceSnapshot } from './records.js';
export { createDroneAirspaceSource } from './source.js';
export * from './cards.js';

/** Fill/line color for a zone by TYPE_CODE. */
export function droneAirspaceColor(typeCode) {
  return Cesium.Color.fromCssColorString(droneAirspaceAccent(typeCode));
}

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

const PICK_PREFIX = 'drone-airspace:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Own one drone-restriction display, its refresh lifecycle, and click selection. */
export function createDroneAirspaceLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Drone airspace requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _snapshotSignature = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  /** @type {Map<string, {stableId: string, anchor: {lon: number, lat: number}}>} */
  const _rowById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = {
      ...buildDroneAirspaceCard(row),
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      DRONE_AIRSPACE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's zone ids, or null. */
  function pickedZoneId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const zoneId = pickId.slice(PICK_PREFIX.length).split(':')[0];
    return _rowById.has(zoneId) ? zoneId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a zone. Unowned, our picks read as
    // "empty space" to siblings — the same contract as fire perimeters.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: DRONE_AIRSPACE_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const zoneId = picked ? pickedZoneId(picked) : null;
      if (zoneId) {
        _selectedId = zoneId;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(DRONE_AIRSPACE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'drone-airspace',
    name: 'Drone Restrictions',
    icon: '🚫',
    source: 'FAA SUA',
    updateInterval: 3600000,

    init(viewer) {
      if (_viewer)
        throw new Error('Drone airspace layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('drone-airspace');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:DroneAirspace] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(DRONE_AIRSPACE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const signature = JSON.stringify(
          rows
            .map(({ polygons, ...facts }) => facts)
            .sort((a, b) => a.stableId.localeCompare(b.stableId)),
        );
        if (signature === _snapshotSignature) {
          if (_selectedId) publishSelectedCard();
          _lastUpdate = Date.now();
          _lastError = null;
          return true;
        }
        const nextEntities = [];
        _rowById.clear();
        for (const row of rows) {
          const color = droneAirspaceColor(row.typeCode);
          for (const [index, rings] of row.polygons.entries()) {
            const [outer, ...holes] = rings;
            const outerPositions = ringPositions(outer);
            nextEntities.push(
              new Cesium.Entity({
                id: `drone-airspace:${row.stableId}:${index}`,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    outerPositions,
                    holes.map(
                      (hole) =>
                        new Cesium.PolygonHierarchy(ringPositions(hole)),
                    ),
                  ),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.25),
                  ),
                },
                polyline: {
                  positions: outerPositions,
                  clampToGround: true,
                  width: 2,
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.9),
                  ),
                },
              }),
            );
          }
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: droneAirspaceAnchorDegrees(polygons),
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _snapshotSignature = signature;
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:DroneAirspace] Updated: ${_count} zones, ${nextEntities.length} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:DroneAirspace] Fetch error:', e);
        _lastError = e?.message || 'Drone airspace source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _snapshotSignature = null;
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

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        const { anchor, stableId, ...facts } = row;
        result.push({
          id: stableId,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    getRowControls() {
      const bands = [
        { label: 'Prohibited (P)', color: droneAirspaceAccent('P') },
        { label: 'Restricted (R)', color: droneAirspaceAccent('R') },
      ];
      return {
        chips: [],
        legend: bands.map((band, index) => ({
          ...band,
          count: [..._rowById.values()].filter(
            (row) => droneAirspaceAccent(row.typeCode) === band.color,
          ).length,
          ...(index === 0
            ? {
                blurb:
                  'FAA special-use airspace. Informational only — not a substitute for official UAS flight-planning tools (B4UFLY / LAANC).',
              }
            : {}),
        })),
      };
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
