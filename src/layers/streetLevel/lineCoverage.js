import * as Cesium from 'cesium';
import { passesImageryFilter } from './filter.js';
import { groundUnderCamera, viewFocus, visibleBbox } from './view.js';
import { tilesForBbox } from './tileMath.js';
import { msg } from '../../i18n/index.js';

/** Sequences per primitive: smaller batches build, and show, sooner. */
const SEQUENCE_PRIMITIVE_BATCH = 120;

/** Hint above the street-zoom ceiling, where no coverage is drawn. */
export const ZOOM_IN_HINT = msg('Zoom in to see street-level coverage');
/** Hint when no ground is in view within range (looking at the sky). */
const NO_GROUND_HINT = msg(
  'Point the camera at the ground for street-level coverage',
);

/** Sequence id for a line's pick id (`<prefix><id>`), else null. */
export function sequenceIdFromPick(pickId, prefix) {
  if (typeof pickId !== 'string' || !prefix || !pickId.startsWith(prefix))
    return null;
  return pickId.slice(prefix.length) || null;
}

/**
 * A provider's coverage bookkeeping, before the first refresh. A provider
 * with a key waits for its status (`blocked: 'status'`); a keyless one
 * draws at once.
 */
export function freshCoverage({ keyless = false } = {}) {
  return {
    zoom: null,
    /** Current zoom's tiles by `z/x/y` key. */
    tiles: new Map(),
    /** The selected sequence drawn over the coverage, or null. */
    highlight: null,
    /** Tile key → its request's controller; any entry means LOADING. */
    pending: new Map(),
    lastError: null,
    /**
     * Why tile requests are paused, or null: 'status' until the key status
     * answers, 'no-key', 'rejected' (until the provider goes off) or
     * 'rate-limited' (until `blockTimer` fires).
     */
    blocked: keyless ? null : 'status',
    blockTimer: null,
    debounceTimer: null,
    removeCameraListener: null,
    terrainReady: null,
    hint: '',
  };
}

/** Line instances for sequences' parts, every part picking its sequence. */
function lineInstances(sequences, color, width, prefix) {
  const attributes = {
    color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
  };
  const instances = [];
  for (const sequence of sequences)
    for (const coordinates of sequence.parts) {
      let positions;
      try {
        positions = Cesium.Cartesian3.fromDegreesArray(coordinates.flat());
      } catch {
        continue;
      }
      if (positions.length < 2) continue;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({ positions, width }),
          id: `${prefix}${sequence.id}`,
          attributes,
        }),
      );
    }
  return instances;
}

/** Draped lines that follow terrain and 3D tiles (Google 3D) alike. */
function linePrimitive(geometryInstances, asynchronous) {
  return new Cesium.GroundPolylinePrimitive({
    geometryInstances,
    appearance: new Cesium.PolylineColorAppearance(),
    classificationType: Cesium.ClassificationType.BOTH,
    asynchronous,
    allowPicking: true,
  });
}

function pointsOf(sequence) {
  let count = 0;
  for (const part of sequence.parts) count += part.length;
  return count;
}

/**
 * @typedef {object} LineCoverageTuning
 * @property {number} maxTiles            Tiles drawn at once.
 * @property {number} maxSequences        Lines drawn at once, over every tile.
 * @property {number} [maxPoints]         Line points drawn at once, over every tile (default: no limit).
 * @property {number} lineWidthPx
 * @property {number} moveDebounceMs      Camera rest before the tile set is recomputed.
 * @property {number} viewRangeMinM       Coverage reaches at least this far…
 * @property {number} viewRangePerHeight  …or camera height times this.
 * @property {boolean} [keepOrder]        Cap a tile's lines in the order decoded (default: newest first).
 */

/**
 * Camera-driven sequence lines from any XYZ line-tile source, near the
 * ground only, draped on terrain and 3D tiles alike. Nothing is drawn from
 * orbit.
 *
 * @param {object} options
 * @param {object} options.state  Provider state: `context`, `services`, `viewer`, `coverage` (freshCoverage), `sequence`.
 * @param {(tile: {x: number, y: number, z: number}, init: {signal: AbortSignal}) => Promise<{sequences: Array<object>}>} options.fetchTile
 *   A decoded tile; sequences are `{id, parts, capturedAt, isPano}`. A
 *   rejection may carry `keyRequired`, `keyRejected` or `retryAfterSec`.
 * @param {(heightM: number|null) => number|null} options.zoomFor
 *   Tile zoom for a camera height above ground; null draws nothing.
 * @param {{coverage: string, selected: string}} options.colors
 * @param {string} options.pickPrefix   Pick-id prefix of the lines.
 * @param {string} options.renderKey    Render-governor reason.
 * @param {LineCoverageTuning} options.tuning
 * @param {{keyRejected?: string, rateLimited: string, tooHigh?: string}} options.messages
 * @param {(sequence: object, filter: object) => boolean} [options.passes]  Whether the imagery filter keeps a line.
 */
export function createLineCoverage({
  state,
  fetchTile,
  zoomFor,
  colors,
  pickPrefix,
  renderKey,
  tuning,
  messages,
  passes = passesImageryFilter,
}) {
  const { render } = state.services;
  const perTileSequenceCap = Math.floor(tuning.maxSequences / tuning.maxTiles);
  const perTilePointCap = tuning.maxPoints
    ? Math.floor(tuning.maxPoints / tuning.maxTiles)
    : Infinity;

  function requestRender() {
    render?.governorRequestRender?.(renderKey);
  }

  function ensureTerrainReady() {
    return (state.coverage.terrainReady ||=
      Cesium.GroundPolylinePrimitive.initializeTerrainHeights());
  }

  function tileKey({ x, y, z }) {
    return `${z}/${x}/${y}`;
  }

  /** The imagery filter, resolved now: "since N days" moves with the clock. */
  function filter() {
    return state.context.getFilter();
  }

  /**
   * A tile's sequences, filtered then capped: capping first could leave a
   * dense tile of newer flat captures with no 360° lines at all. A line past
   * the point budget is skipped; a shorter one may still fit. The selected
   * sequence is the answer to a click: it is drawn whatever the caps leave
   * out, and not counted against them.
   */
  function drawnSequences(entry) {
    const drawn = [];
    const current = filter();
    const selectedId = state.sequence.selectedId ?? null;
    let points = 0;
    let counted = 0;
    for (const sequence of entry.sequenceList) {
      if (!passes(sequence, current)) continue;
      if (sequence.id === selectedId) {
        drawn.push(sequence);
        continue;
      }
      if (counted >= perTileSequenceCap) continue;
      const size = pointsOf(sequence);
      if (points + size > perTilePointCap) continue;
      points += size;
      counted++;
      drawn.push(sequence);
    }
    return drawn;
  }

  /** Batched draped primitives for a tile's sequences. */
  function buildSequencePrimitives(sequences) {
    const instances = lineInstances(
      sequences,
      Cesium.Color.fromCssColorString(colors.coverage).withAlpha(0.92),
      tuning.lineWidthPx,
      pickPrefix,
    );
    const primitives = [];
    for (let i = 0; i < instances.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push(
        linePrimitive(instances.slice(i, i + SEQUENCE_PRIMITIVE_BATCH), true),
      );
    return primitives;
  }

  /**
   * Draw the selected sequence again over the coverage, in the selection
   * colour, from every loaded tile it crosses; none when nothing is selected.
   * Built at once: its tiles loaded, so the terrain table has too.
   */
  function highlight(sequenceId = state.sequence.selectedId) {
    const scene = state.viewer?.scene;
    if (state.coverage.highlight) {
      scene?.groundPrimitives?.remove(state.coverage.highlight);
      state.coverage.highlight = null;
    }
    if (!sequenceId || !scene) return;
    // From every loaded line, drawn or not: a sequence selected after its
    // tiles were drawn may have been left out by their caps.
    const current = filter();
    const parts = [];
    for (const entry of state.coverage.tiles.values()) {
      const sequence = entry.sequenceList.find(({ id }) => id === sequenceId);
      if (sequence && passes(sequence, current)) parts.push(...sequence.parts);
    }
    const instances = lineInstances(
      [{ id: sequenceId, parts }],
      Cesium.Color.fromCssColorString(colors.selected),
      tuning.lineWidthPx + 1,
      pickPrefix,
    );
    if (!instances.length) return;
    state.coverage.highlight = scene.groundPrimitives.add(
      linePrimitive(instances, false),
    );
    requestRender();
  }

  function attachPrimitive(entry) {
    const scene = state.viewer?.scene;
    if (!scene) return;
    // Lookup, picking and counts follow what is drawn, not the whole tile.
    const sequences = drawnSequences(entry);
    entry.sequences = new Map(sequences.map((s) => [s.id, s]));
    entry.primitives = buildSequencePrimitives(sequences);
    for (const primitive of entry.primitives)
      scene.groundPrimitives.add(primitive);
  }

  function detachPrimitive(entry) {
    const scene = state.viewer?.scene;
    for (const primitive of entry.primitives || []) {
      try {
        scene?.groundPrimitives?.remove(primitive);
      } catch {
        /* already gone */
      }
    }
    entry.primitives = [];
  }

  function removeTile(key) {
    const entry = state.coverage.tiles.get(key);
    if (!entry) return;
    detachPrimitive(entry);
    state.coverage.tiles.delete(key);
  }

  async function loadTile(tile) {
    const key = tileKey(tile);
    if (state.coverage.tiles.has(key) || state.coverage.pending.has(key))
      return;
    const controller = new AbortController();
    state.coverage.pending.set(key, controller);
    notify();
    try {
      // Fetch and the one-time terrain-height table load run side by side,
      // both handled from the start so an early tile failure is not unhandled.
      const [decoded] = await Promise.all([
        fetchTile(tile, { signal: controller.signal }),
        ensureTerrainReady(),
      ]);
      // Only an abort, a zoom change, a clear or a newer request for this tile
      // discards it; a refresh that still wants the tile keeps it.
      if (
        controller.signal.aborted ||
        state.coverage.pending.get(key) !== controller ||
        state.coverage.tiles.has(key) ||
        tile.z !== state.coverage.zoom
      )
        return;
      const sequences = decoded?.sequences || [];
      const entry = { primitives: [], sequences: new Map() };
      // Newest first, unless the provider ordered them itself; the per-tile
      // cap applies to what passes the filter.
      entry.sequenceList = tuning.keepOrder
        ? sequences
        : sequences.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
      entry.total = sequences.length;
      attachPrimitive(entry);
      state.coverage.tiles.set(key, entry);
      state.coverage.lastError = null;
      // Over the new lines, and along any of the selection's parts they add.
      if (entry.sequences.has(state.sequence.selectedId)) highlight();
      requestRender();
    } catch (error) {
      if (
        controller.signal.aborted ||
        state.coverage.pending.get(key) !== controller
      )
        return;
      // Every other tile would be refused too: stop asking.
      if (error?.keyRejected) block('rejected');
      else if (error?.keyRequired) block('no-key');
      else if (error?.retryAfterSec) block('rate-limited', error.retryAfterSec);
      else
        state.coverage.lastError =
          error?.message || msg('Coverage tile failed');
    } finally {
      // Only the request that still owns the key settles it: a superseded one
      // must not drop a newer request's entry (which is what counts as loading).
      if (state.coverage.pending.get(key) === controller)
        state.coverage.pending.delete(key);
      notify();
    }
  }

  /**
   * Pause tile requests (see `blocked` in freshCoverage). A rate limit keeps
   * what is drawn and refreshes once its wait is over; a key problem
   * outranks it, and a rejected key holds until `unblock` (the provider goes
   * off).
   */
  function block(reason, retryAfterSec = 0) {
    const current = state.coverage.blocked;
    if (current === 'rejected') return;
    if (reason === 'rate-limited' && current === 'no-key') return;
    clearTimeout(state.coverage.blockTimer);
    state.coverage.blockTimer = null;
    state.coverage.blocked = reason;
    if (reason === 'rate-limited')
      state.coverage.blockTimer = setTimeout(() => {
        state.coverage.blockTimer = null;
        state.coverage.blocked = null;
        refresh();
      }, retryAfterSec * 1000);
  }

  /** The provider went off: forget refusals and errors, so the next run asks again. */
  function unblock() {
    clearTimeout(state.coverage.blockTimer);
    state.coverage.blockTimer = null;
    if (['rejected', 'rate-limited'].includes(state.coverage.blocked))
      state.coverage.blocked = null;
    state.coverage.lastError = null;
  }

  /** The server's key status: until it answers, nothing is requested. */
  function setKeyStatus(configured) {
    if (!configured) block('no-key');
    else if (['status', 'no-key'].includes(state.coverage.blocked)) {
      state.coverage.blocked = null;
      refresh();
    }
    notify();
  }

  function notify() {
    state.context.notify();
  }

  /**
   * The tiles for the camera: what the screen shows within range of it, at
   * the zoom for its height above ground, nearest the camera first.
   */
  function wantedTiles(viewer) {
    const ground = groundUnderCamera(viewer);
    const cameraHeight = viewer.camera?.positionCartographic?.height;
    const height = Number.isFinite(cameraHeight)
      ? cameraHeight - (ground ?? 0)
      : null;
    const zoom = zoomFor(height);
    if (zoom == null) return { hint: messages.tooHigh || ZOOM_IN_HINT };
    // Rays meet the ground where it really is (1,600 m up in Denver) and stop
    // short of the horizon, which would stretch the box to the world.
    const ranged = {
      groundHeight: ground,
      maxRange: Math.max(
        tuning.viewRangeMinM,
        height * tuning.viewRangePerHeight,
      ),
    };
    const bbox = visibleBbox(viewer, ranged);
    if (!bbox) return { hint: NO_GROUND_HINT };
    // Ranked from between the camera's ground point and the screen centre's:
    // a tilted view's box centre can sit kilometres past both.
    const tiles = tilesForBbox(bbox, zoom, {
      limit: tuning.maxTiles,
      from: viewFocus(viewer, ranged),
    });
    return { zoom, tiles };
  }

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !state.context.isActive() || state.coverage.blocked) return;
    const { zoom, tiles, hint } = wantedTiles(viewer);
    if (hint) {
      state.coverage.hint = hint;
      clear();
      notify();
      return;
    }
    state.coverage.hint = '';
    state.coverage.zoom = zoom;
    const wanted = new Set(tiles.map(tileKey));
    for (const key of [...state.coverage.tiles.keys()])
      if (!wanted.has(key)) removeTile(key);
    for (const [key, controller] of [...state.coverage.pending])
      if (!wanted.has(key)) {
        // The aborted request no longer owns its key, so its `finally` will
        // not settle it: settle it here.
        controller.abort();
        state.coverage.pending.delete(key);
      }
    for (const tile of tiles) loadTile(tile);
    notify();
  }

  function scheduleRefresh() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = setTimeout(refresh, tuning.moveDebounceMs);
  }

  function attach(viewer) {
    detach();
    const remove = viewer.camera.changed.addEventListener(scheduleRefresh);
    const removeEnd = viewer.camera.moveEnd.addEventListener(scheduleRefresh);
    state.coverage.removeCameraListener = () => {
      remove();
      removeEnd();
    };
    refresh();
  }

  function detach() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = null;
    state.coverage.removeCameraListener?.();
    state.coverage.removeCameraListener = null;
  }

  function clear() {
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    for (const key of [...state.coverage.tiles.keys()]) removeTile(key);
    highlight(null);
    state.coverage.zoom = null;
    requestRender();
  }

  /** Rebuild every loaded tile from its decoded lines (after a filter change). */
  function rebuild() {
    for (const entry of state.coverage.tiles.values()) {
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    highlight();
    requestRender();
    notify();
  }

  /** Load every tile again (a source that filters on its server had its filter changed). */
  function reload() {
    clear();
    refresh();
  }

  /**
   * Sequences drawn. A sequence that crosses a tile edge is in both tiles'
   * lists, so sequences count once by id.
   */
  function sequenceCount() {
    const ids = new Set();
    for (const entry of state.coverage.tiles.values())
      for (const id of entry.sequences.keys()) ids.add(id);
    return ids.size;
  }

  /** What the panel and the layer list show: count, LOADING, key gate, error. */
  function stats() {
    const { blocked } = state.coverage;
    return {
      count: sequenceCount(),
      // Waiting for the key status is loading too, not an empty view.
      loading:
        state.coverage.pending.size > 0 ||
        (blocked === 'status' && state.context.isActive()),
      hint: state.coverage.hint,
      keyRequired: blocked === 'no-key' || blocked === 'rejected',
      keyRejected: blocked === 'rejected',
      error:
        blocked === 'rejected'
          ? messages.keyRejected || null
          : blocked === 'rate-limited'
            ? messages.rateLimited
            : state.coverage.lastError,
    };
  }

  return {
    attach,
    detach,
    refresh,
    clear,
    unblock,
    setKeyStatus,
    rebuild,
    reload,
    highlight,
    sequenceCount,
    stats,
  };
}
