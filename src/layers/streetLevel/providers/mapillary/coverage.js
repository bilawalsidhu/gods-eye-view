import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter } from '../../filter.js';
import { cameraHeightAboveGround, visibleBbox } from '../../view.js';
import { densifyLine, MESH_DENSIFY_DEG } from '../../groundCast.js';
import { MESH_CELL_DEG } from '../../meshSampler.js';
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
  PICK_PREFIX,
} from './policy.js';

/** Draped lines stay at most this long while a tile's cast lines build. */
const SWAP_MAX_WAIT_MS = 4000;
/** Tiles touched by new mesh samples are redrawn at most this often. */
const REMESH_INTERVAL_MS = 1500;
/** Gap between redrawing one dirty tile and the next. */
const REMESH_STAGGER_MS = 120;
/** Old-zoom tiles are kept at most this long after a zoom change. */
const STALE_TILE_MAX_MS = 6000;
/**
 * Sequences per ground primitive. Ground polyline geometry is built on a
 * worker in proportion to the instance count, so smaller batches put the
 * first lines on screen sooner instead of one big batch arriving late.
 */
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

/**
 * Sequence id for a picked line, whichever part was hit: `mly:seq:<id>` and
 * `mly:seq:<id>~<part>` both give `<id>`; null for any other pick.
 * @param {string} pickId
 * @returns {string|null}
 */
export function sequenceIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX.sequence))
    return null;
  const rest = pickId.slice(PICK_PREFIX.sequence.length);
  const cut = rest.indexOf(PART_SEPARATOR);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/**
 * Camera-driven coverage: z0–5 `overview` points from orbit down to 60 km,
 * then z11–14 sequence polylines clamped to terrain and 3D tiles. Decoded
 * tiles are kept so the imagery filter can rebuild without refetching.
 *
 * In the core's terrain surface mode (Google 3D at street zoom) a tile's
 * lines are cast to the bare earth instead: draped lines would land on roofs
 * and tree tops. A tile is drawn draped first and swapped for its cast lines
 * once the terrain heights are in, so coverage never waits on the terrain.
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

  function filter() {
    return state.filter;
  }

  function terrainMode() {
    return (
      state.context.getSurface?.() === 'terrain' &&
      Boolean(state.context.groundCaster)
    );
  }

  /**
   * Primitives for a tile's sequences, in draw batches: ground primitives
   * draped on the globe, plus (in terrain mode) plain polylines at the cast
   * heights for every part whose heights are cached. Each part of a sequence
   * with a capture gap is its own line.
   */
  function buildSequencePrimitives(sequences) {
    const ground = terrainMode() ? state.context.groundCaster : null;
    const meshAt = ground ? state.context.meshSampler?.meshAt : undefined;
    const draped = [];
    const cast = [];
    let drawn = 0;
    for (const sequence of sequences) {
      if (!passesImageryFilter(sequence, filter())) continue;
      drawn++;
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        sequenceColor({ selected: sequence.id === state.sequence.selectedId }),
      );
      const ids = partIds(sequence);
      sequence.parts.forEach((coordinates, index) => {
        const flat = ground?.castLine(coordinates, { meshAt });
        let positions;
        try {
          positions = flat
            ? Cesium.Cartesian3.fromDegreesArrayHeights(flat)
            : Cesium.Cartesian3.fromDegreesArray(coordinates.flat());
        } catch {
          return;
        }
        if (positions.length < 2) return;
        const geometry = flat
          ? new Cesium.PolylineGeometry({
              positions,
              width: COVERAGE_LINE_WIDTH_PX,
              vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
              arcType: Cesium.ArcType.NONE,
            })
          : new Cesium.GroundPolylineGeometry({
              positions,
              width: COVERAGE_LINE_WIDTH_PX,
            });
        (flat ? cast : draped).push(
          new Cesium.GeometryInstance({
            geometry,
            id: ids[index],
            attributes: { color },
          }),
        );
      });
    }
    const primitives = [];
    for (let i = 0; i < draped.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push({
        onGround: true,
        primitive: new Cesium.GroundPolylinePrimitive({
          geometryInstances: draped.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          allowPicking: true,
        }),
      });
    for (let i = 0; i < cast.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push({
        onGround: false,
        primitive: new Cesium.Primitive({
          geometryInstances: cast.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          asynchronous: true,
          allowPicking: true,
        }),
      });
    return { primitives, count: drawn, draped };
  }

  /**
   * Fetch the terrain heights a tile's lines need, then redraw the tile cast.
   * Runs once per tile entry; unresolved lines stay draped.
   */
  function castTile(entry) {
    if (entry.castRequested || !terrainMode()) return;
    entry.castRequested = true;
    entry.castAbort = new AbortController();
    const { signal } = entry.castAbort;
    const lines = entry.sequenceList
      .filter((sequence) => passesImageryFilter(sequence, filter()))
      .flatMap((sequence) => sequence.parts);
    const caster = state.context.groundCaster;
    caster.prepareLines(lines, { signal }).then(() => {
      const attached = [...state.coverage.tiles.values()].includes(entry);
      if (signal.aborted || !attached || !terrainMode()) return;
      // Nothing new to cast (terrain proxy down, tile too big): keep it draped.
      if (!lines.some((coords) => caster.castLine(coords))) return;
      // Keep the draped lines until the cast ones are built, so nothing blinks.
      const previous = entry.primitives;
      entry.primitives = [];
      attachPrimitive(entry);
      removeWhenReady(entry, previous);
      requestMesh(entry);
    });
  }

  /** The mesh cells under a tile's lines, built once per tile. */
  function meshCells(entry) {
    if (entry.meshCells) return entry.meshCells;
    const cells = new Map();
    for (const sequence of entry.sequenceList)
      for (const [lon, lat] of sequence.parts.flatMap((part) =>
        densifyLine(part, MESH_DENSIFY_DEG),
      ))
        cells.set(
          `${Math.round(lon / MESH_CELL_DEG)},${Math.round(lat / MESH_CELL_DEG)}`,
          [lon, lat],
        );
    entry.meshCells = [...cells.values()];
    return entry.meshCells;
  }

  /** Ask for mesh samples under a cast tile's lines (the sampler keeps the near ones). */
  function requestMesh(entry) {
    const sampler = state.context.meshSampler;
    if (!sampler || entry.kind !== 'sequence' || !terrainMode()) return;
    sampler.request(meshCells(entry));
  }

  /**
   * New mesh samples landed: redraw the tiles they fall in, throttled, with
   * the same no-blink swap as the bare-earth cast.
   */
  function onMeshSampled(batch) {
    if (!terrainMode() || !state.context.isActive()) return;
    for (const entry of state.coverage.tiles.values()) {
      if (entry.kind !== 'sequence' || !entry.bounds) continue;
      const { west, south, east, north } = entry.bounds;
      if (
        batch.some(
          ([lon, lat]) =>
            lon >= west && lon <= east && lat >= south && lat <= north,
        )
      )
        state.coverage.remeshDirty.add(entry);
    }
    if (!state.coverage.remeshDirty.size || state.coverage.remeshTimer) return;
    const wait = Math.max(
      0,
      REMESH_INTERVAL_MS - (Date.now() - (state.coverage.remeshAt || 0)),
    );
    state.coverage.remeshTimer = setTimeout(remesh, wait);
  }

  /** Redraw one dirty tile per idle slice, so a burst of samples never stalls a frame. */
  function remesh() {
    state.coverage.remeshTimer = null;
    state.coverage.remeshAt = Date.now();
    if (!terrainMode() || !state.context.isActive()) {
      state.coverage.remeshDirty.clear();
      return;
    }
    const attached = new Set(state.coverage.tiles.values());
    const [entry] = state.coverage.remeshDirty;
    if (!entry) return;
    state.coverage.remeshDirty.delete(entry);
    if (attached.has(entry)) {
      const previous = entry.primitives;
      entry.primitives = [];
      attachPrimitive(entry);
      removeWhenReady(entry, previous);
      requestRender();
    }
    if (state.coverage.remeshDirty.size)
      state.coverage.remeshTimer = setTimeout(
        () => idleTask(remesh),
        REMESH_STAGGER_MS,
      );
  }

  function idleTask(task) {
    if (typeof globalThis.requestIdleCallback === 'function')
      globalThis.requestIdleCallback(() => task(), { timeout: 500 });
    else task();
  }

  state.coverage.remeshDirty = new Set();
  state.context.meshSampler?.onSampled(onMeshSampled);

  /**
   * Remove a tile's previous primitives once all its current ones are ready
   * (or after a few seconds); detaching the tile removes them at once.
   */
  function removeWhenReady(entry, old) {
    const scene = state.viewer?.scene;
    finishSwap(entry);
    if (!scene?.postRender) {
      removePrimitives(old);
      return;
    }
    const fresh = entry.primitives;
    const started = Date.now();
    const stop = scene.postRender.addEventListener(() => {
      const ready = fresh.every(
        ({ primitive }) => primitive.ready || primitive.isDestroyed?.(),
      );
      if (!ready && Date.now() - started < SWAP_MAX_WAIT_MS) {
        requestRender();
        return;
      }
      finishSwap(entry);
      requestRender();
    });
    entry.swap = { old, stop };
    requestRender();
  }

  function finishSwap(entry) {
    if (!entry.swap) return;
    entry.swap.stop();
    removePrimitives(entry.swap.old);
    entry.swap = null;
  }

  function buildOverviewCollection(points) {
    const collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    const green = Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(
      0.85,
    );
    let count = 0;
    for (const point of points) {
      if (!passesImageryFilter(point, filter())) continue;
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        color: green,
        pixelSize: COVERAGE_OVERVIEW_POINT_PX,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      count++;
    }
    return { collection, count };
  }

  function attachPrimitive(entry) {
    const scene = state.viewer?.scene;
    if (!scene) return;
    if (entry.kind === 'sequence') {
      const { primitives, count, draped } = buildSequencePrimitives(
        entry.sequenceList,
      );
      entry.primitives = primitives;
      entry.count = count;
      for (const { primitive, onGround } of primitives)
        (onGround ? scene.groundPrimitives : scene.primitives).add(primitive);
      if (draped.length) castTile(entry);
    } else {
      const { collection, count } = buildOverviewCollection(entry.points);
      entry.primitive = collection;
      entry.count = count;
      scene.primitives.add(collection);
    }
  }

  function removePrimitives(list) {
    const scene = state.viewer?.scene;
    for (const { primitive, onGround } of list || []) {
      try {
        (onGround ? scene?.groundPrimitives : scene?.primitives)?.remove(
          primitive,
        );
      } catch {
        /* already gone */
      }
    }
  }

  function detachPrimitive(entry) {
    const scene = state.viewer?.scene;
    finishSwap(entry);
    removePrimitives(entry.primitives);
    entry.primitives = [];
    if (entry.primitive) {
      try {
        scene?.primitives?.remove(entry.primitive);
      } catch {
        /* already gone */
      }
      entry.primitive = null;
    }
  }

  /** Stop a tile's pending terrain lookup (tile dropped or retired). */
  function cancelCast(entry) {
    entry.castAbort?.abort();
    entry.castAbort = null;
  }

  function removeTile(key) {
    const entry = state.coverage.tiles.get(key);
    if (!entry) return;
    cancelCast(entry);
    detachPrimitive(entry);
    state.coverage.tiles.delete(key);
  }

  async function loadTile(tile, kind) {
    const key = tileKey(tile);
    if (state.coverage.tiles.has(key) || state.coverage.pending.has(key))
      return;
    const controller = new AbortController();
    state.coverage.pending.set(key, controller);
    state.coverage.loading++;
    notify();
    try {
      // Fetch and the one-time terrain-height table load run side by side.
      const fetching = source.getTile('coverage', tile.z, tile.x, tile.y, {
        signal: controller.signal,
      });
      if (kind === 'sequence') await ensureTerrainReady();
      const bytes = await fetching;
      // A refresh that still wants this tile must not throw the bytes away;
      // only an abort (tile no longer wanted, or zoom changed) does.
      // A retire, clear or newer request for this tile owns it now.
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
        // Newest first, capped per tile so a dense city stays within budget.
        const sequences = decoded.sequences
          .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
          .slice(0, PER_TILE_SEQUENCE_CAP);
        entry.sequenceList = sequences;
        entry.sequences = new Map(sequences.map((s) => [s.id, s]));
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
    } finally {
      // Only the request that still owns the key settles it: a superseded one
      // must not drop a newer request's entry or its loading count.
      if (state.coverage.pending.get(key) === controller) {
        state.coverage.pending.delete(key);
        state.coverage.loading = Math.max(0, state.coverage.loading - 1);
        if (!state.coverage.pending.size) purgeStale();
      }
      notify();
    }
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

  /**
   * Move every loaded tile to the stale set instead of removing it, so the
   * old zoom stays visible while the new zoom streams in (no blank globe).
   */
  function retire() {
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    state.coverage.loading = 0;
    for (const [key, entry] of state.coverage.tiles) {
      cancelCast(entry);
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

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !state.context.isActive() || state.keyRequired) return;
    const height = cameraHeightAboveGround(viewer, {
      groundAt: state.context.groundCaster?.groundAt,
    });
    const sequenceZoom = coverageZoomForHeight(height);
    const overviewZoom = sequenceZoom ? null : overviewZoomForHeight(height);
    const zoom = sequenceZoom ?? overviewZoom;
    const kind = sequenceZoom ? 'sequence' : 'overview';
    let bbox = visibleBbox(viewer);
    if (kind === 'overview' && (!bbox || zoom <= 1))
      bbox = [-180, -85, 180, 85];
    if (!zoom || !bbox) {
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
    });
    const wanted = new Set(tiles.map(tileKey));
    for (const key of [...state.coverage.tiles.keys()])
      if (!wanted.has(key)) removeTile(key);
    for (const [key, controller] of [...state.coverage.pending])
      if (!wanted.has(key)) {
        controller.abort();
        state.coverage.pending.delete(key);
      }
    for (const tile of tiles) loadTile(tile, kind);
    // The camera moved: cells that were out of the sampler's range may not be.
    if (terrainMode())
      for (const entry of state.coverage.tiles.values())
        if (entry.castRequested) requestMesh(entry);
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
    state.coverage.loading = 0;
    for (const key of [...state.coverage.tiles.keys()]) removeTile(key);
    purgeStale();
    state.coverage.zoom = null;
    state.coverage.kind = null;
    clearTimeout(state.coverage.remeshTimer);
    state.coverage.remeshTimer = null;
    state.coverage.remeshDirty.clear();
    requestRender();
  }

  /** Rebuild every loaded tile from its decoded cache (after a filter change). */
  function rebuild() {
    purgeStale();
    for (const entry of state.coverage.tiles.values()) {
      cancelCast(entry);
      entry.castRequested = false;
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    requestRender();
    notify();
  }

  /**
   * Redraw loaded tiles draped or cast after the core's surface mode changes,
   * then re-pick the zoom: the bare-earth height under the camera that the
   * change brings in can move it (a high city reads much closer to the street).
   */
  function setSurface() {
    if (!state.context.isActive()) return;
    rebuild();
    refresh();
  }

  /** Look a sequence up across loaded tiles. */
  function findSequence(id) {
    for (const entry of state.coverage.tiles.values()) {
      const hit = entry.sequences.get(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Recolour one sequence, every part of it, in place (selection highlight). */
  function recolorSequence(id, selected) {
    const value = sequenceColor({ selected });
    for (const entry of state.coverage.tiles.values()) {
      const sequence = entry.sequences.get(id);
      if (!sequence) continue;
      for (const instanceId of partIds(sequence))
        for (const { primitive } of entry.primitives || []) {
          if (!primitive.ready) continue;
          try {
            const attributes =
              primitive.getGeometryInstanceAttributes(instanceId);
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
    requestRender();
  }

  function sequenceCount() {
    let count = 0;
    for (const entry of state.coverage.tiles.values()) count += entry.count;
    return count;
  }

  return {
    attach,
    detach,
    refresh,
    clear,
    rebuild,
    setSurface,
    findSequence,
    recolorSequence,
    sequenceCount,
  };
}
