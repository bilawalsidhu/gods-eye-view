import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter } from '../../filter.js';
import { cameraHeightAboveGround, visibleBbox } from '../../view.js';
import {
  coverageZoomForHeight,
  overviewZoomForHeight,
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
  COVERAGE_RECENT_DAYS,
  PICK_PREFIX,
} from './policy.js';

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

/** Colour for a sequence: brand green, dimmer with age, magenta for panoramas. */
function sequenceColor(sequence, { selected = false, now = Date.now() } = {}) {
  if (selected) return Cesium.Color.fromCssColorString(COLORS.selected);
  if (sequence.isPano)
    return Cesium.Color.fromCssColorString(COLORS.pano).withAlpha(0.9);
  const ageDays = (now - (sequence.capturedAt || 0)) / 86_400_000;
  return ageDays <= COVERAGE_RECENT_DAYS
    ? Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92)
    : Cesium.Color.fromCssColorString(COLORS.coverageOld).withAlpha(0.7);
}

/**
 * Camera-driven coverage: z0–5 `overview` points from orbit down to 60 km,
 * then z11–14 sequence polylines clamped to terrain and 3D tiles. Decoded
 * tiles are kept so the imagery filter can rebuild without refetching.
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

  /** One or more ground primitives for a tile's sequences, in draw batches. */
  function buildSequencePrimitives(sequences) {
    const now = Date.now();
    const instances = [];
    for (const sequence of sequences) {
      if (!passesImageryFilter(sequence, filter())) continue;
      const flat = [];
      for (const [lon, lat] of sequence.coordinates) flat.push(lon, lat);
      let positions;
      try {
        positions = Cesium.Cartesian3.fromDegreesArray(flat);
      } catch {
        continue;
      }
      if (positions.length < 2) continue;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions,
            width: COVERAGE_LINE_WIDTH_PX,
          }),
          id: `${PICK_PREFIX.sequence}${sequence.id}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              sequenceColor(sequence, {
                now,
                selected: sequence.id === state.sequence.selectedId,
              }),
            ),
          },
        }),
      );
    }
    const primitives = [];
    for (let i = 0; i < instances.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: instances.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          allowPicking: true,
        }),
      );
    return { primitives, count: instances.length };
  }

  function buildOverviewCollection(points) {
    const collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    const green = Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(
      0.85,
    );
    const pink = Cesium.Color.fromCssColorString(COLORS.pano).withAlpha(0.9);
    let count = 0;
    for (const point of points) {
      if (!passesImageryFilter(point, filter())) continue;
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        color: point.isPano ? pink : green,
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
      const { primitives, count } = buildSequencePrimitives(entry.sequenceList);
      entry.primitives = primitives;
      entry.count = count;
      for (const primitive of primitives) scene.groundPrimitives.add(primitive);
    } else {
      const { collection, count } = buildOverviewCollection(entry.points);
      entry.primitive = collection;
      entry.count = count;
      scene.primitives.add(collection);
    }
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
    if (entry.primitive) {
      try {
        scene?.primitives?.remove(entry.primitive);
      } catch {
        /* already gone */
      }
      entry.primitive = null;
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
      if (
        controller.signal.aborted ||
        kind !== state.coverage.kind ||
        tile.z !== state.coverage.zoom
      )
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      const entry = { kind, primitive: null, primitives: [], count: 0 };
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
      if (controller.signal.aborted) return;
      state.coverage.lastError = error?.message || 'Coverage tile failed';
      if (error?.keyRequired) state.keyRequired = true;
    } finally {
      state.coverage.pending.delete(key);
      state.coverage.loading = Math.max(0, state.coverage.loading - 1);
      if (!state.coverage.pending.size) purgeStale();
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
    const height = cameraHeightAboveGround(viewer);
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

  /** Look a sequence up across loaded tiles. */
  function findSequence(id) {
    for (const entry of state.coverage.tiles.values()) {
      const hit = entry.sequences.get(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Recolour one sequence in place (selection highlight). */
  function recolorSequence(id, selected) {
    const instanceId = `${PICK_PREFIX.sequence}${id}`;
    for (const entry of state.coverage.tiles.values()) {
      const sequence = entry.sequences.get(id);
      if (!sequence) continue;
      for (const primitive of entry.primitives || []) {
        if (!primitive.ready) continue;
        try {
          const attributes =
            primitive.getGeometryInstanceAttributes(instanceId);
          if (attributes)
            attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
              sequenceColor(sequence, { selected }),
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
    findSequence,
    recolorSequence,
    sequenceCount,
  };
}
