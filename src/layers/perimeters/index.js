import * as Cesium from 'cesium';
import {
  PERIMETER_OVERLAY_SOURCE_ID,
  perimeterAnchorDegrees,
  buildIncidentCard,
  containmentAccent,
} from './cards.js';
import {
  findInciwebLink,
  inciwebNodeId,
  isCurrentPublication,
} from './inciweb.js';
export { normalizeFirePerimeterSnapshot } from './records.js';
export { createWfigsPerimeterSource } from './source.js';
export * from './cards.js';
export * from './inciweb.js';

/** Fill/line color for a perimeter by containment progress (same ramp as the card accent). */
export function containmentColor(containedPct) {
  return Cesium.Color.fromCssColorString(containmentAccent(containedPct));
}

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

const PICK_PREFIX = 'fire-perimeter:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
// The InciWeb catalog changes on the order of days; refreshing it on the
// 5-minute perimeter cadence would hammer a public .gov endpoint for ~200 KB
// of near-identical bytes.
const INCIWEB_INDEX_TTL_MS = 6 * 3600000;

/** Own one fire-perimeter display, its refresh lifecycle, and click selection. */
export function createFirePerimetersLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  inciwebSource = null,
  inciwebPublications = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fire perimeters require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _linkRequest = null;
  let _snapshotSignature = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedLink = null;
  let _selectedCardId = null;
  let _inciwebIndex = [];
  let _indexFetchedAt = 0;
  let _indexFetchInFlight = false;
  /** @type {Map<string, {stableId: string, anchor: {lon: number, lat: number}}>} */
  const _rowById = new Map();
  // Link → currency verdict from the publication check; unknown links are
  // absent. Failed checks are not cached so a transient outage retries.
  const _linkVerdicts = new Map();
  function abortLinkVerification() {
    _linkRequest?.controller.abort();
    _linkRequest = null;
  }

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  /**
   * Refresh the InciWeb catalog off the render path: a hanging or failed
   * fetch only costs the link line, never the perimeter refresh — the
   * catalog is consumed solely by the selected card.
   */
  function refreshInciwebIndex(signal) {
    if (!inciwebSource || _indexFetchInFlight) return;
    if (Date.now() - _indexFetchedAt < INCIWEB_INDEX_TTL_MS) return;
    _indexFetchInFlight = true;
    inciwebSource
      .getIndex({ signal })
      .then((rows) => {
        if (signal.aborted || !_enabled || !Array.isArray(rows)) return;
        _inciwebIndex = rows;
        _indexFetchedAt = Date.now();
        if (_selectedId) publishSelectedCard();
      })
      .catch(() => {
        // Catalog unavailable — cards stay linkless until the next attempt.
      })
      .finally(() => {
        _indexFetchInFlight = false;
      });
  }

  /**
   * Verify that a matched publication describes the current incident, not
   * an archived same-name fire — the catalog is all-time. Async: the card
   * republishes with the link once (and only if) the check passes.
   */
  function verifyLink(link, row) {
    const id = inciwebNodeId(link);
    if (!id || !inciwebPublications || _linkRequest?.link === link) return;
    abortLinkVerification();
    const request = { link, controller: new AbortController() };
    _linkRequest = request;
    const { signal } = request.controller;
    inciwebPublications
      .getPublication(id, { signal })
      .then((publication) => {
        if (signal.aborted || _linkRequest !== request || !_enabled) return;
        _linkVerdicts.set(
          link,
          isCurrentPublication(publication, {
            discoveredTime: row.discoveredTime,
          }),
        );
        if (_selectedId === row.stableId) publishSelectedCard();
      })
      .catch(() => {
        // Fail closed without caching: no link now, retry on reselection.
      })
      .finally(() => {
        if (_linkRequest === request) _linkRequest = null;
      });
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedLink = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        PERIMETER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const candidate = findInciwebLink(_inciwebIndex, row);
    if (candidate && !_linkVerdicts.has(candidate)) verifyLink(candidate, row);
    _selectedLink =
      candidate && _linkVerdicts.get(candidate) === true ? candidate : null;
    const card = {
      ...buildIncidentCard(row, Date.now(), { link: _selectedLink }),
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    if (!openExternal) card.interactive = false;
    if (_selectedLink && openExternal) {
      const link = _selectedLink;
      // Keyboard/assistive activation mirrors the pointer click-through.
      card.activate = () => {
        openExternal(link);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      PERIMETER_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  /** Resolve a scene pick to one of this layer's incident ids, or null. */
  function pickedIncidentId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const incidentId = pickId.slice(PICK_PREFIX.length).split(':')[0];
    return _rowById.has(incidentId) ? incidentId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a perimeter. Unowned, our picks read as
    // "empty space" to siblings — the pre-existing behavior for the globe.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      // A click on the incident card itself opens its InciWeb page (when the
      // incident has one) and never disturbs the selection.
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: PERIMETER_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink && openExternal) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const incidentId = picked ? pickedIncidentId(picked) : null;
      if (incidentId) {
        abortLinkVerification();
        _selectedId = incidentId;
        publishSelectedCard();
        return;
      }
      // A pick that belongs to a sibling layer (e.g. an aircraft) is not
      // "empty space" — leave the selection alone and let that layer handle it.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        abortLinkVerification();
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
    abortLinkVerification();
    _selectedId = null;
    _selectedLink = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(PERIMETER_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'fire-perimeters',
    name: 'Fire Perimeters',
    icon: '🔥',
    source: 'NIFC WFIGS',
    updateInterval: 300000,

    init(viewer) {
      if (_viewer)
        throw new Error('Fire perimeter layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('fire-perimeters');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:FirePerimeters] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
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
      refreshInciwebIndex(request.signal);
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        // Incident facts may change independently of the polygon's source clock.
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
        abortLinkVerification();
        const nextEntities = [];
        _rowById.clear();
        for (const row of rows) {
          const color = containmentColor(row.containedPct);
          for (const [index, rings] of row.polygons.entries()) {
            const [outer, ...holes] = rings;
            const outerPositions = ringPositions(outer);
            nextEntities.push(
              new Cesium.Entity({
                id: `fire-perimeter:${row.stableId}:${index}`,
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
                // The fire line: ground-clamped outline (entity polygons cannot
                // outline clamped geometry themselves).
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
          // Keep a geometry-free projection: the coordinate arrays would
          // otherwise be retained for the layer's lifetime while only the
          // anchor is ever read again.
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: perimeterAnchorDegrees(polygons),
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        _snapshotSignature = signature;
        // Refresh (or drop) the selected incident's card against the new feed.
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:FirePerimeters] Updated: ${_count} incidents, ${nextEntities.length} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:FirePerimeters] Fetch error:', e);
        _lastError = e?.message || 'Perimeter source unavailable';
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
      _inciwebIndex = [];
      _indexFetchedAt = 0;
      _linkVerdicts.clear();
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

    /** Snapshot incident facts (with card-anchor coordinates) for the analyst query engine. */
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
        { label: '0% or unknown', color: containmentAccent(0) },
        { label: '>0–<50% contained', color: containmentAccent(1) },
        { label: '50–<100% contained', color: containmentAccent(50) },
        { label: '100% contained', color: containmentAccent(100) },
      ];
      return {
        chips: [],
        legend: bands.map((band, index) => ({
          ...band,
          count: [..._rowById.values()].filter(
            (row) => containmentAccent(row.containedPct) === band.color,
          ).length,
          ...(index === 0
            ? {
                blurb:
                  'Colour shows reported containment. Perimeters are simplified to about 100 m.',
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
