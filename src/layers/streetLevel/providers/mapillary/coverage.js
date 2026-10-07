import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter, resolveFilter } from '../../filter.js';
import { isActive } from '../../state.js';
import { cameraNadir, groundUnderCamera, visibleBbox } from '../../view.js';
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

/** Old-zoom tiles are kept at most this long after a zoom change. */
const STALE_TILE_MAX_MS = 6000;
/** Sequences per primitive: smaller batches build, and show, sooner. */
const SEQUENCE_PRIMITIVE_BATCH = 120;

const PER_TILE_SEQUENCE_CAP = Math.floor(
  COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES,
);

/** Colour for a sequence: Mapillary green, GEV cyan while selected. */
function sequenceColor({ selected = false } = {}) {
  return selected
    ? Cesium.Color.fromCssColorString(COLORS.selected)
    : Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92);
}

/** Separates a multi-part sequence's part index from its id in pick ids. */
const PART_SEPARATOR = '~';

/** Pick ids for every part of a sequence; the first part is unsuffixed. */
function partIds(sequence) {
  return sequence.parts.map((_, index) =>
    index
      ? `${PICK_PREFIX.sequence}${sequence.id}${PART_SEPARATOR}${index}`
      : `${PICK_PREFIX.sequence}${sequence.id}`,
  );
}

/** Sequence id for any part's pick id (`mly:seq:<id>[~<part>]`), else null. */
export function sequenceIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX.sequence))
    return null;
  const rest = pickId.slice(PICK_PREFIX.sequence.length);
  const cut = rest.indexOf(PART_SEPARATOR);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** Hint above the street-zoom ceiling, where no coverage is drawn. */
export const ZOOM_IN_HINT = 'Zoom in to see street-level coverage';
/** Hint when no ground is in view within range (looking at the sky). */
export const NO_GROUND_HINT =
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

  /**
   * Batched draped primitives for a tile's sequence parts. Each batch records
   * the selection its colours were built with.
   */
  function buildSequencePrimitives(sequences) {
    const selectedId = state.sequence.selectedId ?? null;
    const instances = [];
    for (const sequence of sequences) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        sequenceColor({ selected: sequence.id === selectedId }),
      );
      const ids = partIds(sequence);
      sequence.parts.forEach((coordinates, index) => {
        let positions;
        try {
          positions = Cesium.Cartesian3.fromDegreesArray(coordinates.flat());
        } catch {
          return;
        }
        if (positions.length < 2) return;
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions,
              width: COVERAGE_LINE_WIDTH_PX,
            }),
            id: ids[index],
            attributes: { color },
          }),
        );
      });
    }
    const primitives = [];
    for (let i = 0; i < instances.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push({
        selectedId,
        primitive: new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance(),
          // Drapes on the globe and on 3D tiles (Google 3D) alike.
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          allowPicking: true,
        }),
      });
    return primitives;
  }

  function attachPrimitive(entry) {
    const scene = state.viewer?.scene;
    if (!scene) return;
    // Lookup, picking and counts follow what is drawn, not the whole tile.
    const sequences = drawnSequences(entry);
    entry.sequences = new Map(sequences.map((s) => [s.id, s]));
    entry.primitives = buildSequencePrimitives(sequences);
    entry.count = sequences.length;
    for (const { primitive } of entry.primitives)
      scene.groundPrimitives.add(primitive);
    watchSelection();
  }

  function detachPrimitive(entry) {
    const scene = state.viewer?.scene;
    for (const { primitive } of entry.primitives || []) {
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
      // Only an abort, a retire, a clear or a newer request for this tile
      // discards the bytes; a refresh that still wants the tile keeps them.
      if (
        controller.signal.aborted ||
        state.coverage.pending.get(key) !== controller ||
        state.coverage.tiles.has(key) ||
        tile.z !== state.coverage.zoom
      )
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      const entry = { primitives: [], count: 0, sequences: new Map() };
      // Newest first; the per-tile cap applies to what passes the filter.
      entry.sequenceList = decoded.sequences.sort(
        (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0),
      );
      attachPrimitive(entry);
      state.coverage.tiles.set(key, entry);
      state.coverage.lastError = null;
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
      if (state.coverage.pending.get(key) === controller) {
        state.coverage.pending.delete(key);
        if (!state.coverage.pending.size) purgeStale();
      }
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

  /** Drop the previous zoom's tiles once the new ones are on screen. */
  function purgeStale() {
    clearTimeout(state.coverage.staleTimer);
    state.coverage.staleTimer = null;
    if (!state.coverage.stale.size) return;
    for (const entry of state.coverage.stale.values()) detachPrimitive(entry);
    state.coverage.stale.clear();
    requestRender();
  }

  /** Move tiles to the stale set: the old zoom shows until the new one loads. */
  function retire() {
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    for (const [key, entry] of state.coverage.tiles) {
      const previous = state.coverage.stale.get(key);
      if (previous) detachPrimitive(previous);
      state.coverage.stale.set(key, entry);
    }
    state.coverage.tiles.clear();
    clearTimeout(state.coverage.staleTimer);
    state.coverage.staleTimer = setTimeout(purgeStale, STALE_TILE_MAX_MS);
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
    const bbox = visibleBbox(viewer, {
      groundHeight: ground,
      maxRange: Math.max(
        SEQUENCE_VIEW_RANGE_MIN_M,
        height * SEQUENCE_VIEW_RANGE_PER_HEIGHT,
      ),
    });
    if (!bbox) return { hint: NO_GROUND_HINT };
    // Ranked from the ground under the camera: a tilted view's box centre
    // can sit kilometres ahead of anything near.
    const { tiles } = tilesForBbox(bbox, zoom, {
      limit: COVERAGE_MAX_TILES,
      from: cameraNadir(viewer),
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
    if (zoom !== state.coverage.zoom) {
      retire();
      state.coverage.zoom = zoom;
    }
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
    if (!state.coverage.pending.size) purgeStale();
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
    purgeStale();
    state.coverage.zoom = null;
    stopSelectionWatch();
    requestRender();
  }

  /** Rebuild every loaded tile from its decoded cache (after a filter change). */
  function rebuild() {
    purgeStale();
    for (const entry of state.coverage.tiles.values()) {
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    requestRender();
    notify();
  }

  /** Recolour every part of a sequence in one ready primitive. */
  function recolorInstances(primitive, sequence, selected) {
    const value = sequenceColor({ selected });
    for (const instanceId of partIds(sequence)) {
      try {
        const attributes = primitive.getGeometryInstanceAttributes(instanceId);
        if (attributes)
          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            value,
            attributes.color,
          );
      } catch {
        /* instance not in this primitive */
      }
    }
  }

  /** Every tile on the globe: the current zoom's and the stale zoom's. */
  function drawnEntries() {
    return [...state.coverage.tiles.values(), ...state.coverage.stale.values()];
  }

  /** Recolour one sequence, every part of it, in place (selection highlight). */
  function recolorSequence(id, selected) {
    for (const entry of drawnEntries()) {
      const sequence = entry.sequences.get(id);
      if (!sequence) continue;
      for (const record of entry.primitives || []) {
        // Still building: `syncSelection` catches it up once it is ready.
        if (!record.primitive.ready) continue;
        recolorInstances(record.primitive, sequence, selected);
        if (selected) record.selectedId = id;
        else if (record.selectedId === id) record.selectedId = null;
      }
    }
    requestRender();
  }

  /**
   * Bring a ready primitive's highlight up to the current selection, when
   * it was built with another one (or none). True when it changed.
   */
  function syncSelection(entry, record) {
    const current = state.sequence.selectedId ?? null;
    if (record.selectedId === current || !record.primitive.ready) return false;
    const previous =
      record.selectedId && entry.sequences.get(record.selectedId);
    if (previous) recolorInstances(record.primitive, previous, false);
    const next = current && entry.sequences.get(current);
    if (next) recolorInstances(record.primitive, next, true);
    record.selectedId = current;
    return true;
  }

  /**
   * A primitive cannot be recoloured until it is ready, so while any is
   * building, catch each one up with the selection as it becomes ready.
   */
  function watchSelection() {
    const scene = state.viewer?.scene;
    if (state.coverage.stopSelectionWatch || !scene?.postRender) return;
    const stop = scene.postRender.addEventListener(() => {
      let building = false;
      let changed = false;
      for (const entry of drawnEntries()) {
        for (const record of entry.primitives || []) {
          if (!record.primitive.ready) building = true;
          else if (syncSelection(entry, record)) changed = true;
        }
      }
      if (changed) requestRender();
      if (!building) stopSelectionWatch();
    });
    state.coverage.stopSelectionWatch = stop;
  }

  function stopSelectionWatch() {
    state.coverage.stopSelectionWatch?.();
    state.coverage.stopSelectionWatch = null;
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
      loading: state.coverage.pending.size > 0,
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
    recolorSequence,
    sequenceCount,
    stats,
  };
}
