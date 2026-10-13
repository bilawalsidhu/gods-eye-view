import * as Cesium from 'cesium';
import {
  BORDER_WAITS_OVERLAY_SOURCE_ID,
  BORDER_WAITS_LABEL_COHORT_LIMIT,
  BORDER_WAITS_LABEL_COLLISION_CAPACITY,
  CLOSED_COLOR,
  DELAY_BANDS,
  UNREPORTED_COLOR,
  buildCrossingCard,
  delayBandKey,
  delayColor,
  selectLabelCohort,
} from './cards.js';
export { normalizeBorderWaitSnapshot, headlineLane } from './records.js';
export { createCbpBorderWaitSource } from './source.js';
export { BORDER_CROSSING_LOCATIONS } from './crossings.js';
export * from './cards.js';

const LAYER_ID = 'border-waits';
const PICK_PREFIX = 'border-waits:';

/** Own one border wait display, its refresh lifecycle, and click selection. */
export function createBorderWaitsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Border waits require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _stale = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, Object>} */
  const _rowById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  const positionOf = (row) => Cesium.Cartesian3.fromDegrees(row.lon, row.lat);

  /** Publish the minute labels plus, when one is selected, its card. */
  function publishOverlay() {
    if (!overlayHost || !_enabled) return;
    const rows = [..._rowById.values()];
    const entries = selectLabelCohort(rows).map(({ rowId, ...entry }) => ({
      ...entry,
      position: positionOf(_rowById.get(rowId)),
    }));
    const selected = _selectedId ? _rowById.get(_selectedId) : null;
    if (_selectedId && !selected) _selectedId = null;
    if (selected)
      entries.push({
        ...buildCrossingCard(selected, { stale: _stale }),
        position: positionOf(selected),
      });
    overlayHost.setEntries(BORDER_WAITS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: BORDER_WAITS_LABEL_COHORT_LIMIT + 1,
      collisionCapacity: BORDER_WAITS_LABEL_COLLISION_CAPACITY,
      moving: false,
    });
  }

  /** Resolve a scene pick to one of this layer's crossing ids, or null. */
  function pickedCrossingId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
    return _rowById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      LAYER_ID,
      (pickId) =>
        typeof pickId === 'string' &&
        pickId.startsWith(PICK_PREFIX) &&
        _rowById.has(pickId.slice(PICK_PREFIX.length)),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      const id = picked ? pickedCrossingId(picked) : null;
      if (id) {
        _selectedId = id;
        publishOverlay();
        return;
      }
      // A pick that belongs to a sibling layer is not empty space.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(LAYER_ID, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishOverlay();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    picking?.unregisterPickOwner?.(LAYER_ID);
  }

  function clearOverlay() {
    _selectedId = null;
    if (overlayHost) {
      overlayHost.clearSource(BORDER_WAITS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(BORDER_WAITS_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: LAYER_ID,
    name: 'Border Wait Times',
    icon: '🛂',
    source: 'U.S. CBP',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Border wait layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost?.setVisible?.(BORDER_WAITS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:BorderWaits] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(BORDER_WAITS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      publishOverlay();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearOverlay();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const { rows, stale } = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        _rowById.clear();
        for (const row of rows) {
          _rowById.set(row.id, row);
          nextEntities.push(
            new Cesium.Entity({
              id: `${PICK_PREFIX}${row.id}`,
              position: positionOf(row),
              point: {
                pixelSize: 11,
                color: Cesium.Color.fromCssColorString(delayColor(row)),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                // Keep markers visible through terrain and 3D tiles.
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            }),
          );
        }
        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _stale = stale;
        publishOverlay();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:BorderWaits] Updated: ${_count} crossings${stale ? ' (stale)' : ''}`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:BorderWaits] Fetch error:', e);
        _lastError = e?.message || 'Border wait source unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearOverlay();
      _rowById.clear();
      _viewer = null;
      _enabled = false;
      _stale = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Snapshot crossing facts for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        result.push({
          id: row.id,
          port: row.port,
          crossing: row.crossing,
          border: row.border,
          status: row.portStatus,
          delayMinutes: row.delayMinutes,
          delayStatus: row.delayStatus,
          lat: row.lat,
          lon: row.lon,
        });
      }
      return result;
    },

    getRowControls() {
      const rows = [..._rowById.values()];
      const bands = [
        ...DELAY_BANDS.map(({ key, label, color }) => ({ key, label, color })),
        { key: 'closed', label: 'Closed', color: CLOSED_COLOR },
        {
          key: 'unreported',
          label: 'No wait reported',
          color: UNREPORTED_COLOR,
        },
      ];
      return {
        chips: [],
        legend: bands.map(({ key, ...band }, index) => ({
          ...band,
          count: rows.filter((row) => delayBandKey(row) === key).length,
          ...(index === 0
            ? {
                blurb:
                  'Colour shows the passenger-vehicle wait to enter the U.S., as reported by CBP.',
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
        stale: _stale,
      };
    },
  };
  return layer;
}
