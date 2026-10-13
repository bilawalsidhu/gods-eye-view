import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter } from '../../filter.js';
import {
  createHorizonCull,
  groundUnderCamera,
  metresBetween,
  viewFocus,
  visibleBbox,
  whenIdle,
} from '../../view.js';
import { densifyLine, MESH_DENSIFY_DEG } from '../../groundCast.js';
import { MESH_SAMPLE_RADIUS_M } from '../../meshSampler.js';
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

/** Draped lines stay at most this long while a tile's cast lines build. */
export const SWAP_MAX_WAIT_MS = 4000;
/** Tiles touched by new mesh samples are redrawn at most this often. */
const REMESH_INTERVAL_MS = 1500;
/** Gap between redrawing one dirty tile and the next. */
const REMESH_STAGGER_MS = 120;
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
 * Whether any point of `box` ({west, south, east, north}) is within the mesh
 * sampler's range of `centre`, the ground point under the camera.
 */
export function meshBoxInRange(box, centre) {
  // Move the camera's longitude to the box's side of the date line first:
  // clamping 179.999 into a box at -179.99 would pick its far edge.
  const lon =
    centre.lon +
    360 * Math.round(((box.west + box.east) / 2 - centre.lon) / 360);
  const nearest = {
    lon: Math.min(box.east, Math.max(box.west, lon)),
    lat: Math.min(box.north, Math.max(box.south, centre.lat)),
  };
  return metresBetween(centre, nearest) <= MESH_SAMPLE_RADIUS_M;
}

/**
 * Camera-driven coverage: overview points (z0–5) from orbit, sequence lines
 * (z11–14) near the ground. In terrain surface mode a tile is drawn draped
 * first, then swapped for lines cast to the bare earth (draped lines would
 * land on roofs), so coverage never waits on terrain heights.
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

  function terrainMode() {
    return (
      state.context.getSurface?.() === 'terrain' &&
      Boolean(state.context.groundCaster)
    );
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
   * Batched primitives for a tile's sequence parts: cast polylines where
   * terrain heights are cached, draped ground lines otherwise. Each batch
   * records the selection its colours were built with.
   */
  function buildSequencePrimitives(sequences) {
    const ground = terrainMode() ? state.context.groundCaster : null;
    const meshAt = ground ? state.context.meshSampler?.meshAt : undefined;
    const selectedId = state.sequence.selectedId ?? null;
    const draped = [];
    const cast = [];
    for (const sequence of sequences) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        sequenceColor({ selected: sequence.id === selectedId }),
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
        selectedId,
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
        selectedId,
        primitive: new Cesium.Primitive({
          geometryInstances: cast.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          asynchronous: true,
          allowPicking: true,
        }),
      });
    return { primitives, draped, cast: cast.length };
  }

  /**
   * Fetch the terrain heights a tile's lines need, then redraw it cast.
   * `castRequested` stops the redraw from casting again at once; a refresh
   * `retry`s a tile whose lines are still draped (a failed or partial cast),
   * and it is redrawn only when more of its lines can be cast.
   */
  function castTile(entry, { retry = false } = {}) {
    if ((entry.castRequested && !retry) || entry.castAbort || !terrainMode())
      return;
    entry.castRequested = true;
    entry.castAbort = new AbortController();
    const { signal } = entry.castAbort;
    const lines = [...entry.sequences.values()].flatMap(
      (sequence) => sequence.parts,
    );
    const caster = state.context.groundCaster;
    caster.prepareLines(lines, { signal }).then(() => {
      if (entry.castAbort?.signal === signal) entry.castAbort = null;
      const attached = [...state.coverage.tiles.values()].includes(entry);
      if (signal.aborted || !attached || !terrainMode()) return;
      // Nothing new to cast: keep what is drawn until the next refresh.
      // Counted like buildSequencePrimitives: a cast line needs two points.
      const castable = lines.filter(
        (coords) => caster.castLine(coords)?.length >= 6,
      ).length;
      if (castable <= (entry.castLines || 0)) {
        entry.castRequested = (entry.castLines || 0) > 0;
        return;
      }
      // A remesh may have cleared the flag while this was in flight.
      entry.castRequested = true;
      redrawTile(entry);
      requestMesh(entry);
    });
  }

  /** Rebuild a tile's lines; the old ones stay up until the new are ready. */
  function redrawTile(entry) {
    const previous = entry.primitives;
    entry.primitives = [];
    attachPrimitive(entry);
    removeWhenReady(entry, previous);
  }

  /** Lon/lat under the camera, where mesh range is measured from. */
  function meshCentre() {
    const carto = state.viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  /**
   * A tile's drawn lines with bounding boxes, built once per filter; mesh
   * points are densified the first time a line is in range.
   */
  function meshParts(entry) {
    if (entry.meshParts) return entry.meshParts;
    entry.meshParts = [];
    for (const sequence of entry.sequences.values())
      for (const part of sequence.parts) {
        const box = {
          west: Infinity,
          south: Infinity,
          east: -Infinity,
          north: -Infinity,
        };
        for (const [lon, lat] of part) {
          if (lon < box.west) box.west = lon;
          if (lon > box.east) box.east = lon;
          if (lat < box.south) box.south = lat;
          if (lat > box.north) box.north = lat;
        }
        entry.meshParts.push({ part, box, points: null });
      }
    return entry.meshParts;
  }

  /**
   * Ask for mesh samples under a cast tile's lines within the sampler's range
   * of the camera; the rest are asked for when a camera move brings them in.
   */
  function requestMesh(entry) {
    const sampler = state.context.meshSampler;
    if (!sampler || entry.kind !== 'sequence' || !terrainMode()) return;
    const centre = meshCentre();
    if (!centre || !entry.bounds || !meshBoxInRange(entry.bounds, centre))
      return;
    const points = [];
    for (const line of meshParts(entry)) {
      if (!meshBoxInRange(line.box, centre)) continue;
      line.points ||= densifyLine(line.part, MESH_DENSIFY_DEG);
      for (const point of line.points) points.push(point);
    }
    if (points.length) sampler.request(points);
  }

  /** Redraw the tiles new mesh samples fall in, throttled. */
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
      redrawTile(entry);
      requestRender();
    }
    if (state.coverage.remeshDirty.size)
      state.coverage.remeshTimer = setTimeout(
        () => whenIdle(remesh, 500),
        REMESH_STAGGER_MS,
      );
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
      const { primitives, draped, cast } = buildSequencePrimitives(sequences);
      entry.primitives = primitives;
      entry.count = sequences.length;
      for (const { primitive, onGround } of primitives)
        (onGround ? scene.groundPrimitives : scene.primitives).add(primitive);
      // Fewer lines cast than last time: the caster has dropped heights this
      // tile used (a full cache), so it must be cast again.
      if (cast < (entry.castLines || 0)) entry.castRequested = false;
      entry.castLines = cast;
      entry.drapedLines = draped.length;
      if (draped.length) castTile(entry);
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
      entry.overviewPoints = null;
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
    const ground = groundUnderCamera(viewer, {
      groundAt: state.context.groundCaster?.groundAt,
    });
    const cameraHeight = viewer.camera?.positionCartographic?.height;
    const height = Number.isFinite(cameraHeight)
      ? cameraHeight - (ground ?? 0)
      : null;
    const sequenceZoom = coverageZoomForHeight(height);
    const overviewZoom = sequenceZoom ? null : overviewZoomForHeight(height);
    const zoom = sequenceZoom ?? overviewZoom;
    const kind = sequenceZoom ? 'sequence' : 'overview';
    // At street zooms the rays meet the ground where it really is (1,600 m up
    // in Denver; Google 3D hides the globe) and stop short of the horizon.
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
    // The camera moved: cells that were out of the sampler's range may not be,
    // and lines left draped by a failed, partial or dropped cast get another try.
    if (terrainMode())
      for (const entry of state.coverage.tiles.values()) {
        if (entry.castRequested) requestMesh(entry);
        if (entry.drapedLines) castTile(entry, { retry: true });
      }
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
    clearTimeout(state.coverage.remeshTimer);
    state.coverage.remeshTimer = null;
    state.coverage.remeshDirty.clear();
    stopSelectionWatch();
    horizon.stop();
    requestRender();
  }

  /** Rebuild every loaded tile from its decoded cache (after a filter change). */
  function rebuild() {
    purgeStale();
    for (const entry of state.coverage.tiles.values()) {
      cancelCast(entry);
      entry.castRequested = false;
      entry.meshParts = null;
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    requestRender();
    notify();
  }

  /**
   * Redraw tiles draped or cast for the new surface mode, then re-pick the
   * zoom, since the ground height under the camera may have changed.
   */
  function setSurface() {
    if (!state.context.isActive()) return;
    rebuild();
    refresh();
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

  /** A tile's primitives on the globe: its own, and the ones a swap still shows. */
  function drawnRecords(entry) {
    const records = entry.primitives || [];
    return entry.swap ? [...records, ...entry.swap.old] : records;
  }

  /** Recolour one sequence, every part of it, in place (selection highlight). */
  function recolorSequence(id, selected) {
    for (const entry of drawnEntries()) {
      const sequence = entry.sequences.get(id);
      if (!sequence) continue;
      for (const record of drawnRecords(entry)) {
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
        // Lines a swap still shows were ready (or never show): catch up only.
        for (const record of entry.swap?.old || [])
          if (syncSelection(entry, record)) changed = true;
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
    setSurface,
    recolorSequence,
    sequenceCount,
  };
}
