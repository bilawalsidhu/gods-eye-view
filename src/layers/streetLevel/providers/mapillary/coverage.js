import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter, resolveFilter } from '../../filter.js';
import { isActive } from '../../state.js';
import { groundUnderCamera, viewFocus, visibleBbox } from '../../view.js';
import { coverageZoomForHeight, tilesForBbox } from '../../tileMath.js';
import {
  COLORS,
  COVERAGE_LINE_WIDTH_PX,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
  COVERAGE_MOVE_DEBOUNCE_MS,
  KEY_REJECTED_MESSAGE,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_VIEW_RANGE_MIN_M,
  SEQUENCE_VIEW_RANGE_PER_HEIGHT,
} from './policy.js';

/** Sequences per primitive: smaller batches build, and show, sooner. */
const SEQUENCE_PRIMITIVE_BATCH = 120;

const PER_TILE_SEQUENCE_CAP = Math.floor(
  COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES,
);

/** Sequence id for a line's pick id (`mly:seq:<id>`), else null. */
export function sequenceIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX.sequence))
    return null;
  return pickId.slice(PICK_PREFIX.sequence.length);
}

/** Line instances for sequences' parts, every part picking its sequence. */
function lineInstances(sequences, color, width) {
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
          id: `${PICK_PREFIX.sequence}${sequence.id}`,
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

/** Hint above the street-zoom ceiling, where no coverage is drawn. */
export const ZOOM_IN_HINT = 'Zoom in to see street-level coverage';
/** Hint when no ground is in view within range (looking at the sky). */
const NO_GROUND_HINT =
  'Point the camera at the ground for street-level coverage';

/**
 * Camera-driven coverage: Mapillary sequence lines (z11–14) near the ground,
 * draped on terrain and 3D tiles alike. Nothing is drawn from orbit.
 */
export function createCoverage({ state, source }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-coverage');
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
    return resolveFilter(state.filter);
  }

  /**
   * A tile's sequences, filtered then capped: capping first could leave a
   * dense tile of newer flat captures with no 360° lines at all.
   */
  function drawnSequences(entry) {
    const drawn = [];
    const current = filter();
    for (const sequence of entry.sequenceList) {
      if (drawn.length >= PER_TILE_SEQUENCE_CAP) break;
      if (passesImageryFilter(sequence, current)) drawn.push(sequence);
    }
    return drawn;
  }

  /** Batched draped primitives for a tile's sequences. */
  function buildSequencePrimitives(sequences) {
    const instances = lineInstances(
      sequences,
      Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92),
      COVERAGE_LINE_WIDTH_PX,
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
    const parts = [];
    for (const entry of state.coverage.tiles.values())
      parts.push(...(entry.sequences.get(sequenceId)?.parts || []));
    const instances = lineInstances(
      [{ id: sequenceId, parts }],
      Cesium.Color.fromCssColorString(COLORS.selected),
      COVERAGE_LINE_WIDTH_PX + 1,
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
      const [bytes] = await Promise.all([
        source.getTile('coverage', tile.z, tile.x, tile.y, {
          signal: controller.signal,
        }),
        ensureTerrainReady(),
      ]);
      // Only an abort, a zoom change, a clear or a newer request for this tile
      // discards the bytes; a refresh that still wants the tile keeps them.
      if (
        controller.signal.aborted ||
        state.coverage.pending.get(key) !== controller ||
        state.coverage.tiles.has(key) ||
        tile.z !== state.coverage.zoom
      )
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      const entry = { primitives: [], sequences: new Map() };
      // Newest first; the per-tile cap applies to what passes the filter.
      entry.sequenceList = decoded.sequences.sort(
        (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0),
      );
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
      else state.coverage.lastError = error?.message || 'Coverage tile failed';
    } finally {
      // Only the request that still owns the key settles it: a superseded one
      // must not drop a newer request's entry (which is what counts as loading).
      if (state.coverage.pending.get(key) === controller)
        state.coverage.pending.delete(key);
      notify();
    }
  }

  /**
   * Pause tile requests (see `blocked` in state.js). A rate limit keeps what
   * is drawn and refreshes once its wait is over; a key problem outranks it,
   * and a rejected key holds until `unblock` (the layer goes off).
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

  /** The layer went off: forget refusals and errors, so the next run asks again. */
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
    state.notify?.();
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
    const zoom = coverageZoomForHeight(height);
    if (zoom == null) return { hint: ZOOM_IN_HINT };
    // Rays meet the ground where it really is (1,600 m up in Denver) and stop
    // short of the horizon, which would stretch the box to the world.
    const ranged = {
      groundHeight: ground,
      maxRange: Math.max(
        SEQUENCE_VIEW_RANGE_MIN_M,
        height * SEQUENCE_VIEW_RANGE_PER_HEIGHT,
      ),
    };
    const bbox = visibleBbox(viewer, ranged);
    if (!bbox) return { hint: NO_GROUND_HINT };
    // Ranked from between the camera's ground point and the screen centre's:
    // a tilted view's box centre can sit kilometres past both.
    const tiles = tilesForBbox(bbox, zoom, {
      limit: COVERAGE_MAX_TILES,
      from: viewFocus(viewer, ranged),
    });
    return { zoom, tiles };
  }

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !isActive(state) || state.coverage.blocked) return;
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
    state.coverage.debounceTimer = setTimeout(
      refresh,
      COVERAGE_MOVE_DEBOUNCE_MS,
    );
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

  /** Rebuild every loaded tile from its decoded cache (after a filter change). */
  function rebuild() {
    for (const entry of state.coverage.tiles.values()) {
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    highlight();
    requestRender();
    notify();
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
        (blocked === 'status' && isActive(state)),
      hint: state.coverage.hint,
      keyRequired: blocked === 'no-key' || blocked === 'rejected',
      keyRejected: blocked === 'rejected',
      error:
        blocked === 'rejected'
          ? KEY_REJECTED_MESSAGE
          : blocked === 'rate-limited'
            ? RATE_LIMITED_MESSAGE
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
    highlight,
    stats,
  };
}
