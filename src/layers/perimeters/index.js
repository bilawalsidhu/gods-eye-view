import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';
import { PERIMETER_OVERLAY_SOURCE_ID, buildIncidentCard } from './cards.js';
import {
  findInciwebLink,
  inciwebNodeId,
  isCurrentPublication,
} from './inciweb.js';
import { msg, t } from '../../i18n/index.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
export {
  normalizeFirePerimeterSnapshot,
  firePerimeterSnapshot,
  perimeterAnchorDegrees,
} from './records.js';
export { createWfigsPerimeterSource } from './source.js';
export * from './cards.js';
export * from './inciweb.js';

const HOUR_MS = 3600000;

/**
 * Piece colours by age, newest first, as WorldFX draws fire growth: the
 * upper bound of each age and its colour (renderer RGB, 0–1). A piece of
 * unknown birth is drawn as the oldest.
 */
export const PERIMETER_AGE_BANDS = Object.freeze(
  [
    { upToMs: 6 * HOUR_MS, rgb: [1, 0.78, 0.18], label: msg('New in 6 hours') },
    { upToMs: 24 * HOUR_MS, rgb: [1, 0.45, 0.05], label: msg('6–24 hours') },
    { upToMs: 72 * HOUR_MS, rgb: [0.85, 0.16, 0.05], label: msg('1–3 days') },
    {
      upToMs: Infinity,
      rgb: [0.45, 0.06, 0.04],
      label: msg('Older or unknown'),
    },
  ].map((band) => Object.freeze(band)),
);

/**
 * The age band of something born (or last grown) at `time`, seen at `atMs`:
 * an index into PERIMETER_AGE_BANDS.
 */
export function perimeterAgeBand(time, atMs) {
  const last = PERIMETER_AGE_BANDS.length - 1;
  if (!Number.isFinite(time)) return last;
  const age = atMs - time;
  const index = PERIMETER_AGE_BANDS.findIndex(({ upToMs }) => age < upToMs);
  return index < 0 ? last : index;
}

const FILL_ALPHA = 0.35;
const LINE_ALPHA = 0.9;
const LINE_WIDTH_PX = 2;

const withAlpha = ([r, g, b], alpha) => [r, g, b, alpha];
const cssColor = (rgb) =>
  `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));
const validLine = (line, min) =>
  Array.isArray(line) &&
  line.length >= min &&
  line.every(
    (point) =>
      Array.isArray(point) &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]),
  );
const validAnchor = (anchor) =>
  Number.isFinite(anchor?.lon) && Number.isFinite(anchor?.lat);

/**
 * The draw sets the perimeters are drawn in start with this; each layer has
 * its own (`fire-perimeters:1:fills`, …), so several can share a renderer.
 * Picks name them as `Hit.set`.
 */
export const PERIMETER_SET_PREFIX = 'fire-perimeters';
let instances = 0;

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

/**
 * Own one fire-perimeter display, its refresh lifecycle, and click selection.
 *
 * The source's `getSnapshot({signal})` answers fires and the pieces of
 * their burned area (records.js `firePerimeterSnapshot`). Each piece is a
 * ground-clamped fill in one renderer draw set, coloured by its age at the
 * snapshot's `at` (else now), and its outline draped lines in another
 * (`drawOf(viewer)`), made at `init`. When to read again (a timeline, the
 * camera) is the host's call, through the manager's `refreshLayer`.
 * Given a Cesium viewer with no renderer bound, the
 * caller loads the package's `./render/cesium/unbound` export first.
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
  // What the sets show: the snapshot revision and each piece's age band.
  let _drawnKey = null;
  let _fills = null;
  let _lines = null;
  let _setIds = new Set();
  let _count = 0;
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
  /** The snapshot's fires by id, each with its card anchor. */
  let _fireById = new Map();
  /** `<set id>\n<item id>` → the fire that item belongs to. */
  const _fireByItem = new Map();
  const shownAt = () => _at ?? Date.now();
  // Link → currency verdict from the publication check; unknown links are
  // absent. Failed checks are not cached so a transient outage retries.
  const _linkVerdicts = new Map();
  function abortLinkVerification() {
    _linkRequest?.controller.abort();
    _linkRequest = null;
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
        _linkVerdicts.set(
          link,
          isCurrentPublication(publication, {
            discoveredTime: row.discoveredTime,
          }),
        );
        if (_selectedId === row.id) publishSelectedCard();
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
    const row = _selectedId ? _fireById.get(_selectedId) : null;
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
   * The incident a click's draw hit (`Hit`, query.d.ts) belongs to: an item
   * of this layer's own sets, for an incident drawn now; else null.
   */
  function pickedIncidentId(hit) {
    if (!hit || hit.surface || !_setIds.has(hit.set)) return null;
    const incidentId = _fireByItem.get(`${hit.set}\n${hit.id}`);
    return incidentId != null && _fireById.has(incidentId) ? incidentId : null;
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
        if (
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
    });
  }

  /** Draw `pieces`, each in the colour of its age band. */
  function drawPieces(pieces, bands) {
    abortLinkVerification();
    const nextFills = [];
    const nextLines = [];
    const counts = new Map();
    _fireByItem.clear();
    // `fire-perimeter:<fire>:<n>` for fills, `…:<fire>:line:<n>` for lines.
    const itemId = (fireId, kind) => {
      const key = `${kind}${fireId}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const id = `${PICK_PREFIX}${fireId}:${kind}${n}`;
      _fireByItem.set(`${kind ? _lines.id : _fills.id}\n${id}`, fireId);
      return id;
    };
    for (const [index, piece] of pieces.entries()) {
      const { rgb } = PERIMETER_AGE_BANDS[bands[index]];
      // Each exterior keeps its own holes.
      for (const rings of Array.isArray(piece.polygons) ? piece.polygons : []) {
        if (!Array.isArray(rings) || !rings.every((ring) => validLine(ring, 4)))
          continue;
        nextFills.push({
          id: itemId(piece.fireId, ''),
          geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
          fill: withAlpha(rgb, FILL_ALPHA),
          height: 'clampGround',
        });
      }
      // The fire line: the piece's outline draped on the ground, apart from
      // its fill, so a piece cut from a larger area has no line along the
      // cut (lines take ECEF, draw.d.ts `LineItem`).
      for (const line of Array.isArray(piece.outline) ? piece.outline : []) {
        if (!validLine(line, 2)) continue;
        nextLines.push({
          id: itemId(piece.fireId, 'line:'),
          positions: line.map(([lon, lat]) => fromDegrees(lon, lat)),
          widthPx: LINE_WIDTH_PX,
          mode: 'draped',
          style: { kind: 'solid', color: withAlpha(rgb, LINE_ALPHA) },
        });
      }
    }
    _fills.set(nextFills);
    _lines.set(nextLines);
    console.log(
      `[Data:FirePerimeters] Drew ${pieces.length} pieces of ${_fireById.size} fires`,
    );
  }

  function removeClickHandler() {
    _clickSubscription?.();
    _clickSubscription = null;
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
      const draw = drawOf(viewer);
      const prefix = `${PERIMETER_SET_PREFIX}:${++instances}`;
      _fills = draw.shapes({
        id: `${prefix}:fills`,
        clampTo: 'both',
        show: false,
      });
      _lines = draw.lines({
        id: `${prefix}:lines`,
        clampTo: 'both',
        show: false,
      });
      _setIds = new Set([_fills.id, _lines.id]);
      _viewer = viewer;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      console.log('[Data:FirePerimeters] Initialized');
    },

    enable() {
      _enabled = true;
      if (_fills) _fills.show = _lines.show = true;
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_fills) _fills.show = _lines.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_fills) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      refreshInciwebIndex(request.signal);
      try {
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
        const atMs = shownAt();
        const bands = pieces.map((piece) => perimeterAgeBand(piece.born, atMs));
        const drawKey =
          typeof snapshot.revision === 'string'
            ? `${snapshot.revision}\n${bands.join('')}`
            : null;
        _fireById = fires;
        if (drawKey === null || drawKey !== _drawnKey) {
          drawPieces(pieces, bands);
          _drawnKey = drawKey;
        }
        // Refresh (or drop) the selected incident's card against the new
        // snapshot: its ages move with `at` even when nothing is redrawn.
        if (_selectedId) publishSelectedCard();
        _count = fires.size;
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
        if (_request === request) _request = null;
      }
    },

    destroy() {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _fireById = new Map();
      _fireByItem.clear();
      _drawnKey = null;
      _at = null;
      _note = null;
      _inciwebIndex = [];
      _indexFetchedAt = 0;
      _linkVerdicts.clear();
      _viewer = null;
      _enabled = false;
      _fills?.dispose();
      _lines?.dispose();
      _fills = _lines = null;
      _setIds = new Set();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /** Snapshot incident facts (with card-anchor coordinates) for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_fills || !_fills.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const fire of _fireById.values()) {
        if (result.length >= limit) break;
        const { anchor, id, ...facts } = fire;
        result.push({
          id,
          ...facts,
          lat: anchor.lat,
          lon: anchor.lon,
        });
      }
      return result;
    },

    getRowControls() {
      const atMs = shownAt();
      const counts = PERIMETER_AGE_BANDS.map(() => 0);
      for (const fire of _fireById.values())
        counts[perimeterAgeBand(fire.lastGrowthTime, atMs)]++;
      return {
        chips: [],
        legend: PERIMETER_AGE_BANDS.map((band, index) => ({
          label: t(band.label),
          color: cssColor(band.rgb),
          count: counts[index],
          ...(index === 0
            ? { blurb: t('Colour shows how long ago each area was mapped.') }
            : {}),
        })),
        ...(_note ? { info: t(_note) } : {}),
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
