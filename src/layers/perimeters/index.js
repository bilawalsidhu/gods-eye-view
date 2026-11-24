import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { drawOf } from '../../render/rendererOf.js';
import { PERIMETER_OVERLAY_SOURCE_ID, buildIncidentCard } from './cards.js';
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

const HOUR_MS = 3600000;

/**
 * Piece colours by age, newest first. A piece of unknown birth, or born after
 * the moment shown, is drawn as the oldest; the legend counts fires by
 * `lastGrowthTime` the same way.
 */
export const PERIMETER_AGE_BANDS = Object.freeze(
  [
    { upToMs: 6 * HOUR_MS, color: '#ffc72e', label: msg('Last 6 hours') },
    { upToMs: 24 * HOUR_MS, color: '#ff730d', label: msg('6–24 hours') },
    { upToMs: 72 * HOUR_MS, color: '#d9290d', label: msg('1–3 days') },
    {
      upToMs: Infinity,
      color: '#730f0a',
      label: msg('Older or unknown'),
    },
  ].map((band) => Object.freeze(band)),
);

function perimeterAgeBand(time, atMs) {
  const last = PERIMETER_AGE_BANDS.length - 1;
  if (!Number.isFinite(time) || time > atMs) return last;
  return PERIMETER_AGE_BANDS.findIndex(({ upToMs }) => atMs - time < upToMs);
}

const FILL_ALPHA = 0.35;
const LINE_ALPHA = 0.9;
const LINE_WIDTH_PX = 2;

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
 * its own (`fire-perimeters:1:…`), so several can share a renderer. Picks
 * name them as `Hit.set`.
 */
export const PERIMETER_SET_PREFIX = 'fire-perimeters';
let instances = 0;

/**
 * Fills, and lines, one draw set holds before the next new piece starts
 * another. Pieces with ids are drawn in such sets, oldest first, and a read
 * changes only the sets its pieces are in. A renderer may rebuild a whole
 * set for an item added, removed or (a line) recoloured, so small sets keep
 * a timeline step cheap on a busy day; but each set of fills costs draw
 * calls every frame, so those are larger (scripts/qa-perimeters-perf.mjs).
 */
export const PERIMETER_SET_SIZES = Object.freeze({ fills: 8000, lines: 2000 });
const KINDS = ['fills', 'lines'];

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
 * `source.getSnapshot({signal})` resolves to the snapshot the layer draws
 * (records.js `firePerimeterSnapshot` builds it from WFIGS):
 * - `at`: the moment shown, epoch ms, or null for now. Ages, colours and the
 *   legend count from it.
 * - `fetchedAt` (epoch ms or null) and `stale`: a stale snapshot is dated by
 *   its `fetchedAt`.
 * - `revision`: a string that changes whenever any piece does. Without a
 *   string revision the layer redraws on every read.
 * - `note`: text the layer row shows with the legend, or null.
 * - `fires`: `id` (string), `anchor` (`{lon, lat}` degrees, where the card
 *   stands), `lastGrowthTime` (epoch ms or null; the legend counts by it) and
 *   the card facts (`name`, `acres`, `containedPct`, `state`,
 *   `discoveredTime`, `updatedTime`, …). A fire without an id or anchor is
 *   dropped. A fire may have no pieces: it keeps its card and legend count.
 * - `pieces`: `fireId` (a listed fire's id; any other piece is dropped),
 *   `born` (epoch ms or null; the piece's colour), `polygons` (each
 *   `[outer, ...holes]`, rings of `[lon, lat]`) and `outline` (lines of
 *   `[lon, lat]` drawn as the fire line, apart from the fill, so a piece cut
 *   from a larger area has no line along the cut). Optional `id`: a string,
 *   unique among its fire's pieces, that stays the same while the piece's
 *   geometry does. With an id on every piece, a read redraws only the pieces
 *   added, removed or recoloured since the last; without, it redraws them
 *   all.
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
  // What the sets show: the snapshot revision and each piece's age band.
  let _drawnKey = null;
  let _draw = null;
  let _setPrefix = null;
  let _setCount = 0;
  /**
   * The draw sets of each kind, oldest first: `{set, size, pieces}`, with
   * the items it holds (`size`) and its pieces by key, in draw order.
   */
  let _chunks = { fills: [], lines: [] };
  /**
   * Each drawn piece by key (`<fire>\n<piece id>`): its fire, age band, its
   * fill and line items, and the set (`chunks`) each kind is drawn in.
   */
  const _drawn = new Map();
  // Whether the sets hold pieces by id (true), all redrawn at once (false),
  // or nothing yet (null).
  let _byPieceId = null;
  let _lastUpdate = null;
  // The moment the snapshot shows (null: now), and the source's legend note.
  let _at = null;
  let _note = null;
  // The moment the drawn colours were computed at; the legend counts at it
  // too, so it matches the map between reads.
  let _bandsAt = null;
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
  /** `<set id>\n<item id>` → the fire that item belongs to. */
  const _fireByItem = new Map();
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

  function publishSelectedCard() {
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
   * The incident a click's draw hit (`Hit`, query.d.ts) belongs to: an item
   * of this layer's own sets, for an incident drawn now; else null.
   */
  function pickedIncidentId(hit) {
    if (!hit || hit.surface) return null;
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
        _linkFailures.clear();
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
        _selectedId = null;
        publishSelectedCard();
      }
    });
  }

  /** A new draw set of `kind`, drawn over those made before it. */
  function makeSet(kind) {
    const spec = {
      id: `${_setPrefix}:${_setCount++}:${kind}`,
      clampTo: 'both',
      show: _enabled,
    };
    return kind === 'fills' ? _draw.shapes(spec) : _draw.lines(spec);
  }

  /** A new chunk of `kind`, last of its kind, its set made later. */
  function addChunk(kind) {
    const chunk = { set: null, size: 0, pieces: new Map() };
    _chunks[kind].push(chunk);
    return chunk;
  }

  function dropChunks() {
    for (const kind of KINDS)
      for (const chunk of _chunks[kind]) chunk.set?.dispose();
    _chunks = { fills: [], lines: [] };
    _drawn.clear();
    _fireByItem.clear();
  }

  /** Note (or forget) which fire `items` of `set` belong to. */
  function remember(set, items, fireId) {
    for (const { id } of items) {
      const key = `${set.id}\n${id}`;
      if (fireId === null) _fireByItem.delete(key);
      else _fireByItem.set(key, fireId);
    }
  }

  /** Note (or forget) the fires of every item a chunk holds. */
  function rememberChunk(chunk, kind, keep = true) {
    for (const drawn of chunk.pieces.values())
      remember(chunk.set, drawn[kind], keep ? drawn.fireId : null);
  }

  /**
   * A piece's fills (each exterior with its own holes) and fire line, in
   * `band`'s colours; `nextId(kind)` names each, `''` for a fill and
   * `'line:'` for a line.
   */
  function pieceItems(piece, band, nextId) {
    const { color } = PERIMETER_AGE_BANDS[band];
    const fills = [];
    const lines = [];
    for (const rings of Array.isArray(piece.polygons) ? piece.polygons : []) {
      if (!Array.isArray(rings) || !rings.every((ring) => validLine(ring, 3)))
        continue;
      fills.push({
        id: nextId(''),
        geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
        fill: hexColor(color, FILL_ALPHA),
        height: 'clampGround',
      });
    }
    // The fire line: the piece's outline draped on the ground, apart from
    // its fill, so a piece cut from a larger area has no line along the
    // cut (lines take ECEF, draw.d.ts `LineItem`).
    for (const line of Array.isArray(piece.outline) ? piece.outline : []) {
      if (!validLine(line, 2)) continue;
      lines.push({
        id: nextId('line:'),
        positions: line.map(([lon, lat]) => fromDegrees(lon, lat)),
        widthPx: LINE_WIDTH_PX,
        mode: 'draped',
        style: { kind: 'solid', color: hexColor(color, LINE_ALPHA) },
      });
    }
    return { fills, lines };
  }

  /**
   * Without piece ids: every piece drawn again into one set of each kind,
   * its items named `fire-perimeter:<fire>:<n>` and `…:<fire>:line:<n>`.
   */
  function drawAll(pieces, bands) {
    if (_byPieceId !== false) {
      dropChunks();
      _byPieceId = false;
    }
    const chunks = {
      fills: _chunks.fills[0] ?? addChunk('fills'),
      lines: _chunks.lines[0] ?? addChunk('lines'),
    };
    for (const kind of KINDS) chunks[kind].set ??= makeSet(kind);
    _fireByItem.clear();
    const counts = new Map();
    const items = { fills: [], lines: [] };
    for (const [index, piece] of pieces.entries()) {
      const { fireId } = piece;
      const drawn = {
        fireId,
        ...pieceItems(piece, bands[index], (kind) => {
          const key = `${kind}${fireId}`;
          const n = counts.get(key) ?? 0;
          counts.set(key, n + 1);
          return `${PICK_PREFIX}${fireId}:${kind}${n}`;
        }),
      };
      for (const kind of KINDS) {
        remember(chunks[kind].set, drawn[kind], fireId);
        items[kind].push(...drawn[kind]);
      }
    }
    for (const kind of KINDS) chunks[kind].set.set(items[kind]);
    console.log(
      `[Data:FirePerimeters] Drew ${pieces.length} pieces of ${_fireById.size} fires`,
    );
  }

  /**
   * With piece ids: only what changed since the last draw. A piece gone is
   * removed, a new one is added to the newest set of each kind (a new set
   * once that one is full), and one whose age band changed is drawn again
   * in its new colours where it is. Items are named
   * `fire-perimeter:<fire>:<piece>:<n>` and `…:<piece>:line:<n>`, `<piece>`
   * URI-encoded.
   */
  function drawChanges(pieces, bands, keys) {
    if (_byPieceId !== true) {
      dropChunks();
      _byPieceId = true;
    }
    const listed = new Set(keys);
    /**
     * Per chunk: the items removed from it, those to draw in it (new or
     * recoloured), and the pieces new to it.
     */
    const edits = new Map();
    const editOf = (chunk, kind) => {
      let edit = edits.get(chunk);
      if (!edit) {
        edit = { kind, removed: [], drawn: [], added: [] };
        edits.set(chunk, edit);
      }
      return edit;
    };
    let removed = 0;
    for (const [key, drawn] of _drawn) {
      if (listed.has(key)) continue;
      _drawn.delete(key);
      removed += 1;
      for (const kind of KINDS) {
        const chunk = drawn.chunks[kind];
        if (!chunk) continue;
        chunk.pieces.delete(key);
        chunk.size -= drawn[kind].length;
        remember(chunk.set, drawn[kind], null);
        editOf(chunk, kind).removed.push(...drawn[kind]);
      }
    }
    let added = 0;
    let recoloured = 0;
    for (const [index, piece] of pieces.entries()) {
      const key = keys[index];
      const band = bands[index];
      let drawn = _drawn.get(key);
      if (drawn) {
        if (drawn.band === band) continue;
        const { color } = PERIMETER_AGE_BANDS[band];
        const fill = hexColor(color, FILL_ALPHA);
        const lineColor = hexColor(color, LINE_ALPHA);
        drawn.band = band;
        drawn.fills = drawn.fills.map((item) => ({ ...item, fill }));
        drawn.lines = drawn.lines.map((item) => ({
          ...item,
          style: { ...item.style, color: lineColor },
        }));
        for (const kind of KINDS)
          if (drawn.chunks[kind])
            editOf(drawn.chunks[kind], kind).drawn.push(...drawn[kind]);
        recoloured += 1;
        continue;
      }
      const base = `${PICK_PREFIX}${piece.fireId}:${encodeURIComponent(piece.id)}:`;
      const counts = { '': 0, 'line:': 0 };
      drawn = {
        fireId: piece.fireId,
        band,
        ...pieceItems(piece, band, (kind) => `${base}${kind}${counts[kind]++}`),
        chunks: { fills: null, lines: null },
      };
      for (const kind of KINDS) {
        if (!drawn[kind].length) continue;
        let chunk = _chunks[kind].at(-1);
        if (!chunk || chunk.size >= PERIMETER_SET_SIZES[kind])
          chunk = addChunk(kind);
        drawn.chunks[kind] = chunk;
        chunk.pieces.set(key, drawn);
        chunk.size += drawn[kind].length;
        const edit = editOf(chunk, kind);
        edit.drawn.push(...drawn[kind]);
        edit.added.push(drawn);
      }
      _drawn.set(key, drawn);
      added += 1;
    }
    // A chunk left with nothing goes with its set.
    for (const [chunk, { kind }] of edits)
      if (!chunk.pieces.size) {
        chunk.set?.dispose();
        _chunks[kind].splice(_chunks[kind].indexOf(chunk), 1);
        edits.delete(chunk);
      }
    // New sets: fills before lines, so every line is drawn over every fill.
    // A new set of fills is drawn over the line sets made before it, so
    // those are made again, in their order, after it.
    const newFills = _chunks.fills.filter((chunk) => !chunk.set);
    for (const chunk of newFills) chunk.set = makeSet('fills');
    const relaid = newFills.length
      ? _chunks.lines.filter((chunk) => chunk.set)
      : [];
    for (const chunk of relaid) {
      rememberChunk(chunk, 'lines', false);
      chunk.set.dispose();
      chunk.set = null;
    }
    for (const chunk of _chunks.lines) chunk.set ??= makeSet('lines');
    for (const chunk of relaid) {
      chunk.set.set([...chunk.pieces.values()].flatMap(({ lines }) => lines));
      rememberChunk(chunk, 'lines');
      edits.delete(chunk);
    }
    for (const [chunk, edit] of edits) {
      const { kind, removed: gone, drawn: items } = edit;
      for (const drawn of edit.added)
        remember(chunk.set, drawn[kind], drawn.fireId);
      if (gone.length && items.length)
        // Removes and upserts may each rebuild the set: one set does both.
        chunk.set.set(
          [...chunk.pieces.values()].flatMap((drawn) => drawn[kind]),
        );
      else if (gone.length) chunk.set.remove(gone.map(({ id }) => id));
      else chunk.set.upsert(items);
    }
    if (added || removed || recoloured)
      console.log(
        `[Data:FirePerimeters] Drew ${added} new, ${recoloured} recoloured and ${removed} removed of ${pieces.length} pieces of ${_fireById.size} fires`,
      );
  }

  function removeClickHandler() {
    _clickSubscription?.();
    _clickSubscription = null;
  }

  function clearSelection() {
    resetSelection();
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
      _draw = drawOf(viewer);
      _setPrefix = `${PERIMETER_SET_PREFIX}:${++instances}`;
      _viewer = viewer;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      console.log('[Data:FirePerimeters] Initialized');
    },

    enable() {
      _enabled = true;
      for (const kind of KINDS)
        for (const chunk of _chunks[kind]) chunk.set.show = true;
      overlayHost?.setVisible?.(PERIMETER_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      for (const kind of KINDS)
        for (const chunk of _chunks[kind]) chunk.set.show = false;
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
        const atMs = shownAt();
        const bands = pieces.map((piece) => perimeterAgeBand(piece.born, atMs));
        // Pieces by id when every one has its own: `<fire>\n<piece id>`.
        // No pieces at all clear the sets either way.
        let keys = pieces.map((piece) =>
          typeof piece.id === 'string' && piece.id !== ''
            ? `${piece.fireId}\n${piece.id}`
            : null,
        );
        if (
          keys.includes(null) ||
          new Set(keys).size !== keys.length ||
          (!keys.length && _byPieceId === false)
        )
          keys = null;
        const drawKey =
          typeof snapshot.revision === 'string'
            ? `${keys ? 'id' : 'all'}\n${snapshot.revision}\n${bands.join('')}`
            : null;
        _fireById = fires;
        _bandsAt = atMs;
        if (drawKey === null || drawKey !== _drawnKey) {
          if (keys) drawChanges(pieces, bands, keys);
          else drawAll(pieces, bands);
          _drawnKey = drawKey;
        }
        // Refresh (or drop) the selected incident's card against the new
        // snapshot: its ages move with `at` even when nothing is redrawn.
        if (_selectedId) {
          if (_selectedLink === null && !_linkRequest) _linkFailures.clear();
          publishSelectedCard();
        }
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
      dropChunks();
      _byPieceId = null;
      _drawnKey = null;
      _at = null;
      _bandsAt = null;
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
      const atMs = _bandsAt;
      const counts = PERIMETER_AGE_BANDS.map(() => 0);
      for (const fire of _fireById.values())
        counts[perimeterAgeBand(fire.lastGrowthTime, atMs)]++;
      return {
        chips: [],
        legend: PERIMETER_AGE_BANDS.map((band, index) => ({
          label: t(band.label),
          color: band.color,
          count: counts[index],
          ...(index === 0
            ? { blurb: t('Colour shows the age of each area.') }
            : {}),
        })),
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
