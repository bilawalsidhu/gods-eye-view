import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import {
  PERIMETER_LABEL_SOURCE_ID,
  PERIMETER_OVERLAY_SOURCE_ID,
  buildFireLabel,
  buildIncidentCard,
} from './cards.js';
import {
  PERIMETER_LEGEND,
  createPerimeterDrawing,
  perimeterMarkerPx,
} from './drawing.js';
import {
  findInciwebLinks,
  inciwebNodeId,
  isCurrentPublication,
} from './inciweb.js';
import { msg, t } from '../../i18n/index.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
export {
  normalizeFirePerimeterSnapshot,
  perimeterAnchorDegrees,
} from './records.js';
export { createWfigsPerimeterSource } from './source.js';
export * from './cards.js';
export * from './inciweb.js';
export { PERIMETER_LEGEND, PERIMETER_MARKER_FROM_M } from './drawing.js';

const validAnchor = (anchor) =>
  Number.isFinite(anchor?.lon) && Number.isFinite(anchor?.lat);

/**
 * The draw sets the perimeters are drawn in start with this; each layer has
 * its own (`fire-perimeters:1:…`), so several can share a renderer. Picks
 * name them as `Hit.set`.
 */
export const PERIMETER_SET_PREFIX = 'fire-perimeters';
let instances = 0;

// A piece id with a lone UTF-16 surrogate cannot be URI-encoded into its
// items' ids: such a piece counts as one without an id.
const LONE_SURROGATE = /\p{Surrogate}/u;

/** The most name labels published, biggest fires first. */
const LABEL_LIMIT = 64;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
// The InciWeb catalog changes on the order of days; refreshing it on the
// 5-minute perimeter cadence would hammer a public .gov endpoint for ~200 KB
// of near-identical bytes.
const INCIWEB_INDEX_TTL_MS = 6 * 3600000;

/**
 * Own one fire-perimeter display, its refresh lifecycle, and click selection.
 * Each fire draws as one fill with a bright edge over a dark halo, whatever
 * the age of its parts; from far off, as a flame marker sized by its acres,
 * named at middle zoom (`PERIMETER_MARKER_FROM_M`, `PERIMETER_LABEL_RANGE_M`).
 *
 * `source.getSnapshot({signal})` resolves to the snapshot the layer draws
 * (records.js `firePerimeterSnapshot` builds it from WFIGS):
 * - `at`: the moment shown, epoch ms, or null for now. The card's ages count
 *   from it.
 * - `fetchedAt` (epoch ms or null) and `stale`: a stale snapshot is dated by
 *   its `fetchedAt`.
 * - `revision`: for a snapshot drawn whole (see `pieces[].id`), a string
 *   that changes whenever any piece does. Such a snapshot without a string
 *   revision is redrawn on every read.
 * - `note`: text the layer row shows with the legend, or null.
 * - `fires`: `id` (string), `anchor` (`{lon, lat}` degrees, where the card
 *   stands), `lastGrowthTime` (epoch ms or null) and
 *   the card facts (`name`, `acres`, `containedPct`, `state`,
 *   `discoveredTime`, `updatedTime`, …). A fire without an id or anchor is
 *   dropped. A fire may have no pieces: it keeps its card, marker, label and
 *   legend count.
 * - `pieces`: `fireId` (a listed fire's id; any other piece is dropped),
 *   `born` (epoch ms or null; not drawn), `polygons` (each
 *   `[outer, ...holes]`, rings of `[lon, lat]`) and `outline` (lines of
 *   `[lon, lat]` drawn as the fire's edge, apart from the fill, so a piece
 *   cut from a larger area has no line along the cut). A piece's line where
 *   another piece of its fire has a ring through the same two points (newer
 *   growth cut from the area around it) runs inside the fire and is not
 *   drawn (edges.js). Optional `id`: a string, unique among its fire's
 *   pieces, that the source changes with any edit of the piece's `polygons`
 *   or `outline`. A new `revision` alone does not redraw a piece with an
 *   id. With an id on every piece, a read redraws only the fills added or
 *   removed since the last, in snapshot order, and the edges of their
 *   fires. A piece without
 *   an id, or with an id repeated within its fire or holding a lone UTF-16
 *   surrogate, has the snapshot drawn whole.
 *
 * When to read again (a timeline, the camera) is the host's call, through
 * the manager's `refreshLayer`. Given a Cesium viewer with no renderer bound,
 * the caller loads the package's `./render/cesium/unbound` export first.
 */
export function createFirePerimetersLayer({
  source,
  overlayHost = null,
  inputFor = defaultInputFor,
  picking = null,
  inciwebSource = null,
  inciwebPublications = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fire perimeters require a snapshot source');
  let _viewer = null;
  let _request = null;
  let _linkRequest = null;
  // The revision the sets show when drawn whole (null on the id path).
  let _drawnKey = null;
  let _draw = null;
  let _setPrefix = null;
  let _drawing = null;
  // Whether the sets hold pieces by id (true) or all drawn at once (false).
  // Null on startup or after an interrupted draw, so the next read starts over.
  let _byPieceId = null;
  let _lastUpdate = null;
  // The moment the snapshot shows (null: now), and the source's legend note.
  let _at = null;
  let _note = null;
  // The proxy's last snapshot, served while WFIGS is unreachable.
  let _stale = false;
  let _lastError = null;
  let _enabled = false;
  let _clickSubscription = null;
  let _selectedId = null;
  let _selectedLink = null;
  let _selectedCardId = null;
  let _inciwebIndex = [];
  let _indexFetchedAt = 0;
  let _indexFetchInFlight = false;
  let _fireById = new Map();
  const shownAt = () => _at ?? Date.now();
  const _linkPublications = new Map();
  // Retry failed pages on reselection or when a read finds the card linkless.
  const _linkFailures = new Set();
  function abortLinkVerification() {
    _linkRequest?.controller.abort();
    _linkRequest = null;
  }

  function resetSelection() {
    abortLinkVerification();
    _linkFailures.clear();
    _selectedId = null;
    _selectedLink = null;
    _selectedCardId = null;
  }

  const canSelect = () => overlayHost && inputFor && picking;

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
        _linkPublications.set(link, publication ?? {});
        if (_selectedId === row.id) publishSelectedCard();
      })
      .catch(() => {
        if (signal.aborted || _linkRequest !== request || !_enabled) return;
        _linkFailures.add(link);
        if (_selectedId === row.id) publishSelectedCard();
      })
      .finally(() => {
        if (_linkRequest === request) _linkRequest = null;
      });
  }

  function isCurrentLink(publication, row) {
    if (
      _at !== null &&
      !(Number.isFinite(publication.createdMs) && publication.createdMs <= _at)
    )
      return false;
    return isCurrentPublication(publication, {
      discoveredTime: row.discoveredTime,
      nowMs: shownAt(),
    });
  }

  /**
   * The current page among verified candidates: the one whose incident began
   * nearest the fire's discovery, else (no discovery date) the newest.
   */
  function chooseLink(links, row) {
    let best = null;
    let bestGap = Infinity;
    for (const link of links) {
      const publication = _linkPublications.get(link);
      if (!publication || !isCurrentLink(publication, row)) continue;
      const gap = Number.isFinite(row.discoveredTime)
        ? Math.abs(publication.createdMs - row.discoveredTime)
        : 0;
      if (best === null || gap < bestGap) {
        best = link;
        bestGap = gap;
      }
    }
    return best;
  }

  /**
   * Name labels for the biggest fires (`LABEL_LIMIT`), the selected one's
   * card standing in for its label.
   */
  function publishLabels() {
    if (!overlayHost) return;
    const rows = [..._fireById.values()]
      .filter(({ id }) => id !== _selectedId)
      .sort((a, b) => (b.acres || 0) - (a.acres || 0))
      .slice(0, LABEL_LIMIT);
    const entries = rows.map((row) => {
      const entry = {
        ...buildFireLabel(row, {
          // Clear of the marker it stands over.
          gapPx: Math.round(perimeterMarkerPx(row.acres) * 1.25) + 4,
        }),
        position: fromDegrees(row.anchor.lon, row.anchor.lat),
      };
      if (canSelect())
        entry.activate = () => {
          selectFire(row.id);
          return true;
        };
      else entry.interactive = false;
      return entry;
    });
    overlayHost.setEntries(PERIMETER_LABEL_SOURCE_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      collisionCapacity: Math.max(1, entries.length),
      moving: false,
    });
  }

  function selectFire(id) {
    abortLinkVerification();
    _linkFailures.clear();
    _selectedId = id;
    publishSelectedCard();
  }

  function publishSelectedCard() {
    publishLabels();
    if (!canSelect()) return;
    const row = _selectedId ? _fireById.get(_selectedId) : null;
    if (!row) {
      resetSelection();
      overlayHost.setEntries(
        PERIMETER_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    // Live, the newest same-name page stands for the incident. A past `at`
    // checks each own-name page, since the newest may postdate it, and the
    // complex's pages only when none of those is current.
    const groups =
      _at === null
        ? [findInciwebLinks(_inciwebIndex, row).slice(0, 1)]
        : [
            findInciwebLinks(_inciwebIndex, {
              name: row.name,
              state: row.state,
            }),
            findInciwebLinks(_inciwebIndex, {
              name: row.complexName,
              state: row.state,
            }),
          ];
    _selectedLink = null;
    for (const links of groups) {
      const unverified = links.find(
        (link) => !_linkPublications.has(link) && !_linkFailures.has(link),
      );
      if (unverified) {
        verifyLink(unverified, row);
        break;
      }
      _selectedLink = chooseLink(links, row);
      if (_selectedLink) break;
    }
    const card = {
      ...buildIncidentCard(row, shownAt(), { link: _selectedLink }),
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

  /**
   * The incident a click's draw hit (`Hit`, query.d.ts) belongs to, by its
   * `meta.fireId` and this layer's set prefix, if still in the snapshot.
   * A replaced set or item still counts: Cesium draws and picks the old
   * ground primitives until the new ones are ready.
   */
  function pickedIncidentId(hit) {
    if (!hit || hit.surface || !hit.set?.startsWith(`${_setPrefix}:`))
      return null;
    const incidentId = hit.meta?.fireId;
    return typeof incidentId === 'string' && _fireById.has(incidentId)
      ? incidentId
      : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickSubscription || !_viewer) return;
    // Deliberately NOT registered in the pick-ownership registry: sibling
    // layers yield to owned picks before their own overlay-card hit-tests,
    // so claiming these large ground polygons would make FIRMS/vessel/CCTV
    // cards inert anywhere over a perimeter. Unowned, our picks read as
    // "empty space" to siblings — the pre-existing behavior for the globe.
    _clickSubscription = inputFor(_viewer).onClick((event) => {
      // A click on the incident card itself opens its InciWeb page (when the
      // incident has one) and never disturbs the selection.
      // The card or label painted on top takes the click, read once per
      // click so every layer agrees: this area's shapes are background to
      // another layer's card or label painted over them.
      const cardHit = picking.clickCard?.(event) ?? null;
      if (cardHit) {
        // A fire's name label selects it.
        const labelled =
          cardHit.sourceId === PERIMETER_LABEL_SOURCE_ID &&
          String(cardHit.entryId).replace(/^fire-perimeter-label:/, '');
        if (labelled && _fireById.has(labelled)) selectFire(labelled);
        else if (
          cardHit.sourceId === PERIMETER_OVERLAY_SOURCE_ID &&
          cardHit.entryId === _selectedCardId &&
          _selectedLink &&
          openExternal
        )
          openExternal(_selectedLink);
        return;
      }
      const picked = event.topHit;
      const incidentId = picked ? pickedIncidentId(event.drawHit) : null;
      if (incidentId) {
        selectFire(incidentId);
        return;
      }
      // A pick that belongs to a sibling layer (e.g. an aircraft) is not
      // "empty space" — leave the selection alone and let that layer handle it.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    });
  }

  function removeClickHandler() {
    _clickSubscription?.();
    _clickSubscription = null;
  }

  function clearSelection() {
    resetSelection();
    if (overlayHost)
      for (const id of [
        PERIMETER_OVERLAY_SOURCE_ID,
        PERIMETER_LABEL_SOURCE_ID,
      ]) {
        overlayHost.clearSource(id);
        overlayHost.setVisible?.(id, false);
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
      _draw = drawOf(viewer);
      _setPrefix = `${PERIMETER_SET_PREFIX}:${++instances}`;
      _drawing = createPerimeterDrawing({
        draw: _draw,
        prefix: _setPrefix,
        show: () => _enabled,
      });
      _viewer = viewer;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      console.log('[Data:FirePerimeters] Initialized');
    },

    enable() {
      _enabled = true;
      _drawing?.eachSet((set) => {
        set.show = true;
      });
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible?.(PERIMETER_LABEL_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _drawing?.eachSet((set) => {
        set.show = false;
      });
      removeClickHandler();
      clearSelection();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_draw) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const abort = () => request.abort(signal.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      try {
        refreshInciwebIndex(request.signal);
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (!Array.isArray(snapshot?.fires) || !Array.isArray(snapshot.pieces))
          throw new Error(msg('Malformed perimeter snapshot'));
        _stale = snapshot.stale === true;
        // A stale snapshot is as old as its fetch, not this poll.
        const updatedAt =
          _stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : Date.now();
        _at = Number.isFinite(snapshot.at) ? snapshot.at : null;
        _note = typeof snapshot.note === 'string' ? snapshot.note : null;
        // A fire needs an id and the anchor its card stands on; a piece
        // needs its fire.
        const fires = new Map();
        for (const fire of snapshot.fires)
          if (typeof fire?.id === 'string' && validAnchor(fire.anchor))
            fires.set(fire.id, fire);
        const pieces = snapshot.pieces.filter((piece) =>
          fires.has(piece?.fireId),
        );
        // Pieces by id when every one has its own: `<fire>\n<piece id>`.
        // An empty snapshot stays in the current mode.
        // Both modes clear their sets.
        let keys = pieces.map((piece) =>
          typeof piece.id === 'string' &&
          piece.id !== '' &&
          !LONE_SURROGATE.test(piece.id)
            ? `${piece.fireId}\n${piece.id}`
            : null,
        );
        if (
          keys.includes(null) ||
          new Set(keys).size !== keys.length ||
          (!keys.length && _byPieceId === false)
        )
          keys = null;
        _fireById = fires;
        try {
          if (keys) {
            if (_byPieceId !== true) {
              _drawing.dropPerimeters();
              _byPieceId = true;
            }
            // Compared piece by piece: nothing unchanged is written.
            const { added, removed } = _drawing.drawChanges(pieces, keys);
            _drawnKey = null;
            if (added || removed)
              console.log(
                `[Data:FirePerimeters] Drew ${added} new and ${removed} removed of ${pieces.length} pieces of ${fires.size} fires`,
              );
          } else {
            const drawKey =
              typeof snapshot.revision === 'string' ? snapshot.revision : null;
            if (drawKey === null || drawKey !== _drawnKey) {
              if (_byPieceId !== false) {
                _drawing.dropPerimeters();
                _byPieceId = false;
              }
              _drawing.drawAll(pieces);
              _drawnKey = drawKey;
              console.log(
                `[Data:FirePerimeters] Drew ${pieces.length} pieces of ${fires.size} fires`,
              );
            }
          }
          _drawing.drawMarkers(fires);
        } catch (e) {
          // A draw cut short leaves sets the layer's notes no longer match:
          // the next read starts them over.
          _byPieceId = null;
          _drawnKey = null;
          throw e;
        }
        // Refresh (or drop) the selected incident's card against the new
        // snapshot: its ages move with `at` even when nothing is redrawn.
        if (_selectedId) {
          if (_selectedLink === null && !_linkRequest) _linkFailures.clear();
          publishSelectedCard();
        } else publishLabels();
        _lastUpdate = updatedAt;
        _lastError = null;
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
        signal?.removeEventListener('abort', abort);
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _fireById = new Map();
      _drawing?.dispose();
      _drawing = null;
      _byPieceId = null;
      _drawnKey = null;
      _at = null;
      _note = null;
      _inciwebIndex = [];
      _indexFetchedAt = 0;
      _linkPublications.clear();
      _viewer = null;
      _enabled = false;
      _draw = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /** Snapshot incident facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_draw || !_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const fire of _fireById.values()) {
        if (result.length >= limit) break;
        const { anchor, id, ...facts } = fire;
        // A time after the moment shown is unknown in this snapshot.
        if (_at !== null)
          for (const key of ['discoveredTime', 'updatedTime', 'lastGrowthTime'])
            if (facts[key] > _at) facts[key] = null;
        result.push({
          id,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    /** The moment the analyst records show: the snapshot's `at`, or null for now. */
    getAnalystRecordsAt() {
      return _at;
    },

    getRowControls() {
      return {
        chips: [],
        legend: [
          {
            label: t(PERIMETER_LEGEND.label),
            color: PERIMETER_LEGEND.color,
            count: _fireById.size,
          },
        ],
        ...(_note ? { info: t(_note) } : {}),
      };
    },

    getStats() {
      return {
        count: _fireById.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}
