import * as Cesium from 'cesium';
import {
  WARNING_OVERLAY_SOURCE_ID,
  warningAnchorDegrees,
  buildWarningCard,
  warningAccent,
} from './cards.js';
import { WARNING_LEVELS } from './records.js';
import { msg, t } from '../../i18n/index.js';
export {
  normalizeWeatherWarningSnapshot,
  warningLevel,
  WARNING_LEVELS,
} from './records.js';
export { createMetAlertsWarningSource } from './source.js';
export * from './nveRecords.js';
export * from './cards.js';

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

const PICK_PREFIX = 'weather-warning:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const LEVEL_LABELS = Object.freeze({
  yellow: msg('Yellow · moderate'),
  orange: msg('Orange · severe'),
  red: msg('Red · extreme'),
});
/** Warning families, each switchable from the layer row. */
const SOURCES = Object.freeze([
  {
    id: 'met',
    label: msg('Weather'),
    title: msg('MET Norway weather warnings'),
  },
  { id: 'flood', label: msg('Flood'), title: msg('NVE flood warnings') },
  {
    id: 'landslide',
    label: msg('Landslide'),
    title: msg('NVE landslide warnings'),
  },
  {
    id: 'avalanche',
    label: msg('Avalanche'),
    title: msg('Varsom avalanche danger'),
  },
]);
const sourceOf = (row) => row.source ?? 'met';

/** Own one weather-warning display, its refresh lifecycle, and click selection. */
export function createWeatherWarningsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Weather warnings require a snapshot source');
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
  /** @type {Map<string, object>} Geometry-free rows with a card anchor. */
  const _rowById = new Map();
  /** Warning families switched off from the row; display-only, not shared. */
  const _hiddenSources = new Set();
  let _rowControlsListener = null;

  const visibleRows = () =>
    [..._rowById.values()].filter((row) => !_hiddenSources.has(sourceOf(row)));

  /** Show or hide each polygon by its warning family. */
  function applySourceVisibility() {
    for (const entity of _dataSource?.entities.values ?? [])
      entity.show = !_hiddenSources.has(entity.properties?.source?.getValue());
    const selected = _selectedId ? _rowById.get(_selectedId) : null;
    if (selected && _hiddenSources.has(sourceOf(selected))) {
      _selectedId = null;
      publishSelectedCard();
    }
  }

  function toggleSource(id) {
    if (_hiddenSources.has(id)) _hiddenSources.delete(id);
    else _hiddenSources.add(id);
    applySourceVisibility();
    _rowControlsListener?.();
  }

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  const selectedLink = () =>
    (_selectedId && _rowById.get(_selectedId)?.web) || null;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(WARNING_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildWarningCard(row, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    if (!openExternal) card.interactive = false;
    if (row.web && openExternal) {
      const link = row.web;
      // Keyboard/assistive activation mirrors the pointer click-through.
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      WARNING_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's warning ids, or null. */
  function pickedWarningId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    // NVE and Varsom ids contain colons; only the last segment is the polygon index.
    const rest = pickId.slice(PICK_PREFIX.length);
    const warningId = rest.slice(0, rest.lastIndexOf(':'));
    return _rowById.has(warningId) ? warningId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: these
    // county- and sea-sized polygons would otherwise make every sibling
    // layer's card inert anywhere inside a warning area.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: WARNING_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const link = selectedLink();
        if (link && openExternal) openExternal(link);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const warningId = picked ? pickedWarningId(picked) : null;
      if (warningId) {
        _selectedId = warningId;
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
      overlayHost.clearSource(WARNING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(WARNING_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'weather-warnings',
    name: 'Weather Warnings',
    icon: '⚠️',
    source: 'MET Norway',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('Weather warning layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('weather-warnings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:WeatherWarnings] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(WARNING_OVERLAY_SOURCE_ID, true);
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
          const color = Cesium.Color.fromCssColorString(
            warningAccent(row.level),
          );
          // Higher levels draw over lower ones where warnings overlap.
          const zIndex = WARNING_LEVELS.indexOf(row.level);
          for (const [index, rings] of row.polygons.entries()) {
            const [outer, ...holes] = rings;
            const outerPositions = ringPositions(outer);
            nextEntities.push(
              new Cesium.Entity({
                id: `${PICK_PREFIX}${row.stableId}:${index}`,
                show: !_hiddenSources.has(sourceOf(row)),
                properties: { source: sourceOf(row) },
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(
                    outerPositions,
                    holes.map(
                      (hole) =>
                        new Cesium.PolygonHierarchy(ringPositions(hole)),
                    ),
                  ),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.2),
                  ),
                  zIndex,
                },
                polyline: {
                  positions: outerPositions,
                  clampToGround: true,
                  width: 2,
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.85),
                  ),
                  zIndex,
                },
              }),
            );
          }
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: warningAnchorDegrees(polygons),
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _snapshotSignature = signature;
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _rowControlsListener?.();
        console.log(
          `[Data:WeatherWarnings] Updated: ${_count} warnings, ${nextEntities.length} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:WeatherWarnings] Fetch error:', e);
        _lastError = e?.message || msg('Weather warning source unavailable');
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

    /** Snapshot warning facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of visibleRows()) {
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
      const all = [..._rowById.values()];
      const rows = visibleRows();
      return {
        chips: SOURCES.map(({ id, label, title }) => {
          const count = all.filter((row) => sourceOf(row) === id).length;
          return {
            id: `source-${id}`,
            label: count ? `${t(label)} ${count}` : t(label),
            title: _hiddenSources.has(id)
              ? t('Show {name}', { name: t(title) })
              : t('Hide {name}', { name: t(title) }),
            active: !_hiddenSources.has(id),
            onClick: () => toggleSource(id),
          };
        }),
        legend: WARNING_LEVELS.map((level, index) => ({
          label: t(LEVEL_LABELS[level]),
          color: warningAccent(level),
          count: rows.filter((row) => row.level === level).length,
          ...(index === 0
            ? {
                blurb: t(
                  'Official warnings in effect now, yellow and above: MET Norway weather (land and sea), NVE flood and landslide (by municipality) and Varsom avalanche danger (by region). Norway only.',
                ),
              }
            : {}),
        })),
      };
    },

    /** The layer panel's hook for repainting the row after a toggle or refresh. */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
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
