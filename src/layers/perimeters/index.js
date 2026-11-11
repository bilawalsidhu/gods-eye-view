import { bindOverlayHost } from '../../overlays/bindOverlayHost.js';
import { fromDegrees } from '../../geo/cartesian3.js';
import { createPerimetersDisplay } from './render/display.js';
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
import { msg, t } from '../../i18n/index.js';
export { normalizeFirePerimeterSnapshot } from './records.js';
export { createWfigsPerimeterSource } from './source.js';
export * from './cards.js';
export * from './inciweb.js';

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

function samePolygons(left, right) {
  if (left === right) return true;
  return (
    left?.length === right.length &&
    right.every(
      (rings, i) =>
        left[i].length === rings.length &&
        rings.every(
          (ring, j) =>
            left[i][j].length === ring.length &&
            ring.every(
              ([x, y], k) => left[i][j][k][0] === x && left[i][j][k][1] === y,
            ),
        ),
    )
  );
}

/** Own one fire-perimeter display, its refresh lifecycle, and click selection. */
export function createFirePerimetersLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  inciwebSource = null,
  inciwebPublications = null,
  openExternal = null,
  createRenderer = ({ engine }) => createPerimetersDisplay(engine),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fire perimeters require a snapshot source');
  let initialized = false;
  let renderer = null;
  let sceneEngine = null;
  const geometry = new Map();
  let _request = null;
  let _linkRequest = null;
  let _snapshotSignature = null;
  let _count = 0;
  let _lastUpdate = null;
  // The proxy's last snapshot, served while WFIGS is unreachable.
  let _stale = false;
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

  overlayHost = bindOverlayHost(overlayHost, () => sceneEngine);
  const canSelect = () => overlayHost && picking;

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
    if (!canSelect() || !renderer) return;
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
      position: fromDegrees(row.anchor.lon, row.anchor.lat),
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
    const incidentId = pickId.slice(
      PICK_PREFIX.length,
      pickId.lastIndexOf(':'),
    );
    return _rowById.has(incidentId) ? incidentId : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !renderer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a perimeter. Unowned, our picks read as
    // "empty space" to siblings — the pre-existing behavior for the globe.
    _clickHandler = renderer.onClick((click) => {
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
      const picked = click?.picked ?? null;
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
        if (
          pickId &&
          picking.isOwnedByOtherLayer(layer.id, pickId, sceneEngine)
        )
          return;
      }
      if (_selectedId) {
        abortLinkVerification();
        _selectedId = null;
        publishSelectedCard();
      }
    });
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler();
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

    init(viewer, { engine = null } = {}) {
      if (initialized)
        throw new Error('Fire perimeter layer is already initialized');
      initialized = true;
      try {
        if (engine) this.attachRenderer({ engine });
      } catch (error) {
        this.destroy();
        throw error;
      }
    },

    show(enabled) {
      renderer?.setVisible(enabled);
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, enabled);
    },
    attachRenderer({ engine = null } = {}) {
      if (!initialized || renderer)
        throw new Error('Invalid fire perimeter scene attachment');
      sceneEngine = engine;
      renderer = createRenderer({ engine });
      this.show(_enabled);
      if (geometry.size) renderer.replace([...geometry.values()]);
      if (_enabled) {
        overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
        installClickHandler();
        if (_selectedId) publishSelectedCard();
      }
    },

    detachRenderer() {
      removeClickHandler();
      overlayHost?.clearSource(PERIMETER_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, false);
      renderer?.destroy();
      renderer = null;
      sceneEngine = null;
    },

    enable() {
      _enabled = true;
      renderer?.setVisible(true);
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      renderer?.setVisible(false);
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      refreshInciwebIndex(request.signal);
      try {
        // The source contract is getSnapshot; a source that can also say how
        // fresh its rows are (the WFIGS proxy) offers getSnapshotDetail.
        const snapshot =
          typeof source.getSnapshotDetail === 'function'
            ? await source.getSnapshotDetail({ signal: request.signal })
            : { rows: await source.getSnapshot({ signal: request.signal }) };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const { rows } = snapshot;
        _stale = snapshot.stale === true;
        // A stale snapshot is as old as its fetch, not this poll.
        const updatedAt =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();

        // Incident facts may change independently of the polygon's source clock.
        const signature = JSON.stringify(
          rows
            .map(({ polygons, ...facts }) => facts)
            .sort((a, b) => a.stableId.localeCompare(b.stableId)),
        );
        if (
          signature === _snapshotSignature &&
          rows.every((row) =>
            samePolygons(geometry.get(row.stableId)?.polygons, row.polygons),
          )
        ) {
          if (_selectedId) publishSelectedCard();
          _lastUpdate = updatedAt;
          _lastError = null;
          return true;
        }
        abortLinkVerification();
        renderer?.replace(rows);
        geometry.clear();
        _rowById.clear();
        for (const row of rows) {
          geometry.set(row.stableId, row);
          const { polygons, ...facts } = row;
          _rowById.set(row.stableId, {
            ...facts,
            anchor: perimeterAnchorDegrees(polygons),
          });
        }
        _snapshotSignature = signature;
        // Refresh (or drop) the selected incident's card against the new feed.
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
        _lastUpdate = updatedAt;
        _lastError = null;
        console.log(
          `[Data:FirePerimeters] Updated: ${_count} incidents, ${rows.reduce((n, r) => n + r.polygons.length, 0)} polygons`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:FirePerimeters] Fetch error:', e);
        _lastError = e?.message || msg('Perimeter source unavailable');
        // A failure now outranks the stale snapshot still drawn.
        _stale = false;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _snapshotSignature = null;
      _inciwebIndex = [];
      _indexFetchedAt = 0;
      _linkVerdicts.clear();
      initialized = false;
      _enabled = false;
      this.detachRenderer();
      geometry.clear();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /** Snapshot incident facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
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
        { label: t('Not contained or unknown'), color: containmentAccent(0) },
        { label: t('Under 50% contained'), color: containmentAccent(1) },
        { label: t('50–99% contained'), color: containmentAccent(50) },
        { label: t('Fully contained'), color: containmentAccent(100) },
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
                blurb: t(
                  'Colour shows reported containment. Perimeters are simplified to about 100 m.',
                ),
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
