import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter } from '../../filter.js';
import {
  createHorizonCull,
  groundUnderCamera,
  metresBetween,
  viewFocus,
  visibleBbox,
} from '../../view.js';
import {
  coverageZoomForHeight,
  overviewZoomForHeight,
  tileBounds,
  tilesForBbox,
} from '../../tileMath.js';
import {
  COLORS,
  COVERAGE_LINE_WIDTH_PX,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
  COVERAGE_MOVE_DEBOUNCE_MS,
  COVERAGE_OVERVIEW_MAX_TILES,
  COVERAGE_OVERVIEW_POINT_PX,
  KEY_REJECTED_MESSAGE,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_VIEW_NEAR_M,
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

/**
 * Camera-driven coverage: overview points (z0–5) from orbit, sequence lines
 * (z11–14) near the ground, draped on terrain and 3D tiles alike.
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
    return state.context.getFilter();
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

  function buildOverviewCollection(points) {
    const collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    const green = Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(
      0.85,
    );
    const drawn = [];
    const current = filter();
    for (const point of points) {
      if (!passesImageryFilter(point, current)) continue;
      drawn.push(
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
          color: green,
          pixelSize: COVERAGE_OVERVIEW_POINT_PX,
          // Google 3D terrain and clouds must not hide the near side's dots;
          // the horizon cull hides the far side's, which this lets through.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    return { collection, points: drawn };
  }

  /** Every overview point on the globe, current zoom and old alike. */
  function* overviewPoints() {
    for (const entry of drawnEntries())
      if (entry.overviewPoints) yield* entry.overviewPoints;
  }

  // Overview points skip the depth test: hide the far hemisphere's.
  const horizon = createHorizonCull({
    getViewer: () => state.viewer,
    items: overviewPoints,
    onChange: requestRender,
  });

  function attachPrimitive(entry) {
    const scene = state.viewer?.scene;
    if (!scene) return;
    if (entry.kind === 'sequence') {
      // Lookup, picking and counts follow what is drawn, not the whole tile.
      const sequences = drawnSequences(entry);
      entry.sequences = new Map(sequences.map((s) => [s.id, s]));
      entry.primitives = buildSequencePrimitives(sequences);
      entry.count = sequences.length;
      for (const { primitive } of entry.primitives)
        scene.groundPrimitives.add(primitive);
      watchSelection();
    } else {
      const { collection, points } = buildOverviewCollection(entry.points);
      entry.primitive = collection;
      entry.overviewPoints = points;
      entry.count = points.length;
      scene.primitives.add(collection);
      // Cull the new points now, then all of them whenever the camera moves.
      horizon.update(points);
    }
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
    if (entry.primitive) {
      try {
        scene?.primitives?.remove(entry.primitive);
      } catch {
        /* already gone */
      }
      entry.primitive = null;
      entry.overviewPoints = null;
    }
  }

  function removeTile(key) {
    const entry = state.coverage.tiles.get(key);
    if (!entry) return;
    detachPrimitive(entry);
    state.coverage.tiles.delete(key);
  }

  async function loadTile(tile, kind) {
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
        kind === 'sequence' ? ensureTerrainReady() : null,
      ]);
      // Only an abort, a retire, a clear or a newer request for this tile
      // discards the bytes; a refresh that still wants the tile keeps them.
      const current = () =>
        state.coverage.pending.get(key) === controller &&
        !state.coverage.tiles.has(key);
      if (
        controller.signal.aborted ||
        !current() ||
        kind !== state.coverage.kind ||
        tile.z !== state.coverage.zoom
      )
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      const entry = { kind, primitive: null, primitives: [], count: 0 };
      // Padded: vector tiles carry a small buffer past their edge.
      const bounds = tileBounds(tile.x, tile.y, tile.z);
      const pad = (bounds.east - bounds.west) * 0.05;
      entry.bounds = {
        west: bounds.west - pad,
        east: bounds.east + pad,
        south: bounds.south - pad,
        north: bounds.north + pad,
      };
      if (kind === 'sequence') {
        // Newest first; the per-tile cap applies to what passes the filter.
        entry.sequenceList = decoded.sequences.sort(
          (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0),
        );
        entry.sequences = new Map();
        entry.total = decoded.sequences.length;
      } else {
        entry.points = decoded.overview;
        entry.sequences = new Map();
        entry.total = decoded.overview.length;
      }
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
      state.coverage.lastError = error?.message || 'Coverage tile failed';
      if (error?.keyRequired) state.keyRequired = true;
      if (error?.keyRejected) {
        // Every other tile would be refused too: stop asking.
        state.keyRejected = true;
        state.coverage.lastError = KEY_REJECTED_MESSAGE;
      }
      if (error?.retryAfterSec) holdFor(error.retryAfterSec);
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
   * Mapillary is rate-limiting: keep what is drawn, request nothing until the
   * wait is over, then refresh once.
   */
  function holdFor(seconds) {
    clearTimeout(state.coverage.holdTimer);
    state.coverage.holdUntil = Date.now() + seconds * 1000;
    state.coverage.lastError = RATE_LIMITED_MESSAGE;
    state.coverage.holdTimer = setTimeout(() => {
      state.coverage.holdTimer = null;
      state.coverage.holdUntil = 0;
      if (state.coverage.lastError === RATE_LIMITED_MESSAGE)
        state.coverage.lastError = null;
      refresh();
    }, seconds * 1000);
  }

  /** Forget refusals when the provider goes off, so the next run asks again. */
  function resetErrors() {
    clearTimeout(state.coverage.holdTimer);
    state.coverage.holdTimer = null;
    state.coverage.holdUntil = 0;
    state.coverage.lastError = null;
    state.keyRejected = false;
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
    state.context.notify();
  }

  /**
   * Whether the screen centre meets the ground further ahead than the camera
   * is high (a view tilted above 45°), or misses it.
   */
  function isTilted({ nadir, ahead }, height) {
    if (!ahead) return true;
    return metresBetween(nadir, ahead) > Math.max(1, height);
  }

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !state.context.isActive() || state.keyRequired) return;
    if (state.statusKnown === false) return;
    if (state.keyRejected || state.coverage.holdUntil > Date.now()) return;
    const ground = groundUnderCamera(viewer);
    const cameraHeight = viewer.camera?.positionCartographic?.height;
    const height = Number.isFinite(cameraHeight)
      ? cameraHeight - (ground ?? 0)
      : null;
    const sequenceZoom = coverageZoomForHeight(height);
    const overviewZoom = sequenceZoom ? null : overviewZoomForHeight(height);
    const zoom = sequenceZoom ?? overviewZoom;
    const kind = sequenceZoom ? 'sequence' : 'overview';
    // At street zooms the rays meet the ground where it really is (1,600 m up
    // in Denver) and stop short of the horizon.
    const ranged =
      kind === 'sequence'
        ? {
            groundHeight: ground,
            maxRange: Math.max(
              SEQUENCE_VIEW_RANGE_MIN_M,
              height * SEQUENCE_VIEW_RANGE_PER_HEIGHT,
            ),
          }
        : {};
    // Tilted street views rank tiles along the line of sight, from the ground
    // under the camera to the ground at the centre of the screen.
    const focus = kind === 'sequence' ? viewFocus(viewer, ranged) : null;
    let bbox = visibleBbox(viewer, {
      ...ranged,
      // A tilted view's screen rows jump from the first metres to the horizon:
      // keep the ground around the camera too. Looking down needs no help.
      nearRange: focus && isTilted(focus, height) ? SEQUENCE_VIEW_NEAR_M : null,
    });
    if (kind === 'overview' && (!bbox || zoom <= 1))
      bbox = [-180, -85, 180, 85];
    if (zoom == null || !bbox) {
      state.coverage.hint =
        'Point the camera at the globe for street-level coverage';
      clear();
      notify();
      return;
    }
    state.coverage.hint = '';
    if (zoom !== state.coverage.zoom || kind !== state.coverage.kind) {
      retire();
      state.coverage.zoom = zoom;
      state.coverage.kind = kind;
    }
    const { tiles } = tilesForBbox(bbox, zoom, {
      limit:
        kind === 'sequence' ? COVERAGE_MAX_TILES : COVERAGE_OVERVIEW_MAX_TILES,
      focus: focus && { from: focus.nadir, to: focus.ahead },
    });
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
    for (const tile of tiles) loadTile(tile, kind);
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
    state.coverage.kind = null;
    stopSelectionWatch();
    horizon.stop();
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
   * Sequences (or overview points) drawn. A sequence that crosses a tile
   * edge is in both tiles' lists, so sequences count once by id.
   */
  function sequenceCount() {
    const ids = new Set();
    let points = 0;
    for (const entry of state.coverage.tiles.values())
      if (entry.kind === 'sequence')
        for (const id of entry.sequences.keys()) ids.add(id);
      else points += entry.count;
    return ids.size + points;
  }

  return {
    attach,
    detach,
    refresh,
    clear,
    resetErrors,
    rebuild,
    recolorSequence,
    sequenceCount,
  };
}
