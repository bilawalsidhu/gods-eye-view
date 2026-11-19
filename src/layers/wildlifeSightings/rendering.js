import { wildlifeAccent } from './cards.js';
import {
  wildlifeIconModelWork,
  wildlifeIconRelevance,
  compareWildlifeIds,
} from './model.js';
import { createWildlifeBillboardModel } from './billboardModel.js';
import { createWildlifeDensity } from './density.js';
import { createWildlifeIconCollection } from './iconCollection.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findGlobe,
} from '../../render/rendererOf.js';
import { wildlifeSpriteCache } from './sprites.js';
import { isRecentWildlifeSighting } from './records.js';
import {
  drainWildlifeWork,
  createWildlifeWorkQueue,
  WILDLIFE_SYNC_CELL_LIMIT,
  WILDLIFE_WORK_UNIT,
} from './performance.js';
import {
  WILDLIFE_SCALE_BY_DISTANCE,
  WILDLIFE_BADGE_MAX_PX,
  WILDLIFE_SPRITE_PX,
} from './policy.js';

/** Live layer instances, for set ids unique among a renderer's sets. */
let instances = 0;

/** A rebuilt anchor that lands where the old one was. */
function sameAnchor(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Own sighting billboards, density glow and batched privacy cells. */
export function createRendering({ state, services, parts }) {
  const spriteDrawOrder =
    services.sprites?.spriteDrawOrder?.('wildlife-sightings') ?? 0;
  const badgeSprites = services.badgeSprites ?? wildlifeSpriteCache();
  // How anchors are built from degrees (a test may count the builds).
  const anchorAt = services.fromDegrees ?? fromDegrees;
  let batchDepth = 0;
  let pendingRenderReason = null;
  let billboards = null;
  let density = null;
  let cellsSignature = null;
  let ambientAnchorIds = new Set();
  const badgeScreens = new Map();
  const crowdedBadgeIds = new Set();
  const photoCardIds = new Set();
  const appearances = new Map();
  const surfaceAnchors = new WeakMap();
  let operations = null;
  const workQueue = createWildlifeWorkQueue({
    requestIdle: services.requestIdleCallback,
    cancelIdle: services.cancelIdleCallback,
    onSlice: (slice) => services.performanceSlice?.(slice),
  });

  function surfaceAnchor(row) {
    const old = surfaceAnchors.get(row);
    if (old && old.lat === row.lat && old.lon === row.lon) return old.anchor;
    const anchor = anchorAt(row.lon, row.lat);
    surfaceAnchors.set(row, { lat: row.lat, lon: row.lon, anchor });
    if (operations) operations.positionBuilds++;
    return anchor;
  }
  const requestRender = (reason) => {
    // Every write is followed by a render request: send the sets what was
    // written before the frame is asked for.
    state.points?.flush();
    density?.flush();
    if (batchDepth) {
      pendingRenderReason = reason;
      return;
    }
    services.render?.governorRequestRender?.(`wildlife-sightings-${reason}`);
  };
  function beginBatch() {
    batchDepth += 1;
  }
  function endBatch() {
    batchDepth = Math.max(0, batchDepth - 1);
    if (batchDepth || !pendingRenderReason) return;
    const reason = pendingRenderReason;
    pendingRenderReason = null;
    requestRender(reason);
  }
  const surfaceRemovers = [];

  // Reuse the shared ground cache. One bounded resolve lifts cold anchors
  // without per-sighting scene renders and pixel readback.
  let floorResolve = null;
  let floorColdPending = false;
  function position(row) {
    if (row.origin === 'acartia') return surfaceAnchor(row);
    const floor = services.groundFloor?.cachedGroundFloor?.(row.lat, row.lon);
    if (floor == null && !floorColdPending) {
      // Anchors are built after the rows publish; warm once the pass ends.
      floorColdPending = true;
      queueMicrotask(warmColdFloors);
    }
    return Number.isFinite(floor) && floor !== 0
      ? anchorAt(row.lon, row.lat, floor)
      : surfaceAnchor(row);
  }

  function warmColdFloors() {
    if (!floorColdPending || floorResolve) return;
    floorColdPending = false;
    const resolve = services.groundFloor?.resolveGroundFloorCellsBounded;
    if (!state.enabled || typeof resolve !== 'function') return;
    const points = state.renderedRows
      .filter((row) => row.origin !== 'acartia')
      .map((row) => ({ lat: row.lat, lon: row.lon }));
    if (!points.length) return;
    floorResolve = Promise.resolve(resolve(points))
      .catch(() => {})
      .then(() => {
        floorResolve = null;
        resampleAnchors();
      });
  }

  function occluder() {
    const eye = state.viewer ? findCamera(state.viewer)?.pose().position : null;
    return eye ? services.occluderFactory?.(eye) : null;
  }

  function cull() {
    if (!state.enabled) return false;
    const horizon = occluder();
    let changed = false;
    // Only observation badges yield at adjacent bucket edges or to a painted
    // card. Density never participates in picking or icon spacing.
    for (const [id, point] of state.pointById) {
      const anchor = state.positions.get(id);
      const show =
        !photoCardIds.has(id) &&
        !crowdedBadgeIds.has(id) &&
        (!horizon || horizon.isPointVisible(anchor) === true);
      if (point.show === show) continue;
      point.show = show;
      changed = true;
    }
    if (changed) requestRender('cull');
    return changed;
  }

  function updateBadgeSpacing() {
    return drainWildlifeWork(updateBadgeSpacingWork());
  }

  function* updateBadgeSpacingWork() {
    yield 'rank';
    crowdedBadgeIds.clear();
    const buckets = new Map();
    const rows = [...state.renderedRows].sort(
      (a, b) =>
        wildlifeIconRelevance(b, state.selectedId) -
          wildlifeIconRelevance(a, state.selectedId) ||
        compareWildlifeIds(a.stableId, b.stableId),
    );
    yield 'rank';
    let visits = 0;
    for (const row of rows) {
      if (visits++ % WILDLIFE_WORK_UNIT === 0) yield 'rank';
      if (photoCardIds.has(row.stableId)) continue;
      const screen = badgeScreens.get(row.stableId);
      if (!screen) continue;
      const x = Math.floor(screen.x / WILDLIFE_BADGE_MAX_PX);
      const y = Math.floor(screen.y / WILDLIFE_BADGE_MAX_PX);
      let overlaps = false;
      for (let dx = -1; dx <= 1 && !overlaps; dx++) {
        for (let dy = -1; dy <= 1 && !overlaps; dy++) {
          for (const other of buckets.get((x + dx) * 65536 + y + dy) || []) {
            if (operations) operations.spacingTests++;
            if (
              (screen.x - other.x) ** 2 + (screen.y - other.y) ** 2 <
              WILDLIFE_BADGE_MAX_PX ** 2
            ) {
              overlaps = true;
              break;
            }
          }
        }
      }
      if (overlaps) crowdedBadgeIds.add(row.stableId);
      else {
        const key = x * 65536 + y;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(screen);
      }
    }
  }

  // Called only when the host's painted membership changes, never per idle
  // frame. Requested/loading/rejected cards must leave their badges visible.
  function setPhotoCardVisibility(entryIds) {
    const next = new Set();
    for (const id of entryIds)
      if (id.startsWith('sighting:')) next.add(id.slice(9));
    const changed =
      next.size !== photoCardIds.size ||
      [...next].some((id) => !photoCardIds.has(id));
    photoCardIds.clear();
    for (const id of next) photoCardIds.add(id);
    if (!state.enabled) return;
    updateBadgeSpacing();
    cull();
    // A painted thumbnail already names its sighting; drop the repeat label.
    if (changed) parts.selection?.photoCardsChanged?.();
  }

  function resampleAnchors() {
    if (!state.enabled || !state.points) return;
    let changed = false;
    for (const row of state.renderedRows) {
      if (row.origin === 'acartia') continue;
      const point = state.pointById.get(row.stableId);
      if (!point) continue;
      const anchor = position(row);
      if (sameAnchor(anchor, state.positions.get(row.stableId))) continue;
      point.position = anchor;
      state.positions.set(row.stableId, anchor);
      changed = true;
    }
    if (!changed) return;
    beginBatch();
    try {
      cull();
      parts.selection.refreshAmbient();
      parts.selection.publishSelected();
      parts.selection.notify?.();
      parts.selection.refreshContexts();
      requestRender('terrain');
    } finally {
      endBatch();
    }
  }

  function deactivate() {
    workQueue.cancel();
    operations = null;
    for (const remove of surfaceRemovers.splice(0)) remove?.();
  }

  function activate() {
    deactivate();
    if (!state.enabled || !state.viewer) return;
    const refreshBadgeImages = () => {
      if (!state.enabled) return;
      appearances.clear();
      if (billboards?.refreshImages((group) => badgeSprites.get(group)))
        requestRender('font-ready');
    };
    surfaceRemovers.push(badgeSprites.subscribe(refreshBadgeImages));
    refreshBadgeImages();
    // Anchors follow the ground: resample once terrain or the base tiles in
    // view finish loading, and when what heights answer against changes
    // (terrain, the shown tilesets).
    const globe = findGlobe(state.viewer);
    let surface = globe?.surfaceVersion?.();
    // Loaded until the port says otherwise.
    let pending = { tilesPending: 0, terrainPending: 0 };
    const off = globe?.on?.('progress', (progress) => {
      const version = globe.surfaceVersion?.();
      const surfaceChanged = version !== surface;
      surface = version;
      const loaded =
        (progress.terrainPending === 0 && pending.terrainPending !== 0) ||
        (progress.tilesPending === 0 && pending.tilesPending !== 0);
      pending = progress;
      if (surfaceChanged || loaded) resampleAnchors();
    });
    if (typeof off === 'function') surfaceRemovers.push(off);
    services.eventTarget?.addEventListener?.(
      'gev:map-stack-changed',
      resampleAnchors,
    );
    surfaceRemovers.push(() =>
      services.eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        resampleAnchors,
      ),
    );
  }

  function clearCells() {
    state.cells = [];
    cellsSignature = null;
    if (!state.cellSets) return;
    state.cellSets.fills.clear();
    state.cellSets.outlines.clear();
  }

  function stageCells(rows) {
    const cellsVisible = state.band === 'cells' || state.band === 'cards';
    const unique = new Map();
    if (cellsVisible) {
      for (const row of rows) {
        if (!row.cell) continue;
        const cell = row.cell;
        const key = `${cell.south},${cell.west},${cell.north},${cell.east}:${wildlifeAccent(row.iconic)}`;
        if (!unique.has(key)) unique.set(key, row);
      }
    }
    const signature = JSON.stringify([...unique.keys()].sort());
    if (signature === cellsSignature) return false;
    if (!unique.size) {
      clearCells();
      cellsSignature = signature;
      return true;
    }
    cellsSignature = signature;
    const fills = [];
    const outlines = [];
    let index = 0;
    for (const row of unique.values()) {
      const { south, west, north, east } = row.cell;
      const tint = cssColor(wildlifeAccent(row.iconic)) ?? [1, 1, 1, 1];
      const id = `cell:${index++}`;
      fills.push({
        id,
        geometry: { kind: 'rectangle', rect: { west, south, east, north } },
        fill: [tint[0], tint[1], tint[2], 0.25],
        height: 'clampGround',
        pickable: false,
      });
      outlines.push({
        id,
        positions: [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ].map(([lon, lat]) => fromDegrees(lon, lat)),
        widthPx: 2,
        mode: 'draped',
        style: { kind: 'solid', color: [tint[0], tint[1], tint[2], 0.8] },
        pickable: false,
      });
    }
    // Each set swaps its whole contents at once, so the previous privacy
    // cells go as the new ones arrive.
    state.cellSets.fills.set(fills);
    state.cellSets.outlines.set(outlines);
    state.cells = fills;
    requestRender('render');
    return true;
  }

  function init() {
    density = createWildlifeDensity({
      viewer: state.viewer,
      positionForCell: surfaceAnchor,
      requestRender,
      setTimer: services.setTimer,
      clearTimer: services.clearTimer,
      requestIdle: services.requestIdleCallback,
      cancelIdle: services.cancelIdleCallback,
      eventTarget: services.eventTarget,
    });
    const draw = drawOf(state.viewer);
    const prefix = `wildlife-sightings:${++instances}`;
    state.cellSets = {
      fills: draw.shapes({ id: `${prefix}:cells`, clampTo: 'both' }),
      outlines: draw.lines({ id: `${prefix}:cell-outlines`, clampTo: 'both' }),
    };
    state.points = createWildlifeIconCollection(
      draw.icons({ id: `${prefix}:badges`, drawOrder: spriteDrawOrder }),
    );
    state.points.show = false;
    const [near, nearValue, far, farValue] = WILDLIFE_SCALE_BY_DISTANCE;
    const distanceScale = { near, nearValue, far, farValue };
    billboards = createWildlifeBillboardModel({
      collection: state.points,
      pointById: state.pointById,
      positions: state.positions,
      positionForRow: position,
      appearanceForGroup(group) {
        if (!appearances.has(group))
          appearances.set(group, {
            image: badgeSprites.get(group),
            size: [WILDLIFE_SPRITE_PX, WILDLIFE_SPRITE_PX],
            // The sprite includes its tint and white glyph. Multiplication
            // by a taxon colour would tint the glyph as well.
            color: [1, 1, 1, 1],
            scale: 1,
            scaleByDistance: distanceScale,
            disableDepthTest: Number.POSITIVE_INFINITY,
          });
        return appearances.get(group);
      },
    });
  }

  function rebuild() {
    if (!state.enabled || !state.points) return false;
    workQueue.cancel();
    operations = null;
    const work = rebuildWork();
    if (
      (state.gridCells?.length || 0) > WILDLIFE_SYNC_CELL_LIMIT ||
      state.rows.size > WILDLIFE_SYNC_CELL_LIMIT
    ) {
      workQueue.start(work, () => {
        if (!state.enabled) return;
        parts.selection.refreshAmbient();
        parts.selection.publishSelected();
        parts.selection.refreshContexts();
        parts.selection.syncCredits?.();
        parts.selection.notify?.();
        parts.controls?.notify?.();
      });
      return 'pending';
    }
    return drainWildlifeWork(work);
  }

  function* rebuildWork() {
    operations = {
      positionBuilds: 0,
      spacingTests: 0,
      billboardVisits: 0,
      billboardWrites: 0,
    };
    const nowMs = services.now();
    const taxa = state.drawnParams?.taxa ?? state.taxa;
    const canvas = canvasOf(state.viewer);
    const horizon = occluder();
    const densityResult = yield* density.updateWork(
      state.gridAvailable ? state.gridCells || [] : [],
      {
        boxes: state.query?.visibleBoxes ?? state.query?.boxes,
        isPointVisible: horizon
          ? (anchor) => horizon.isPointVisible(anchor) === true
          : null,
        onOperations: (counts) => Object.assign(operations, counts),
      },
    );
    const model = yield* wildlifeIconModelWork({
      rows: [...state.rows.values()].filter(
        (row) =>
          row.stableId === state.selectedId ||
          isRecentWildlifeSighting(row, nowMs, taxa),
      ),
      boxes: state.query?.visibleBoxes ?? state.query?.boxes,
      selectedId: state.selectedId,
      selectedRow: state.selectedRow,
      preferredIds: state.ambientIds,
      onOperations: (counts) => Object.assign(operations, counts),
      projectRow:
        typeof services.project === 'function'
          ? (row) => {
              const anchor = surfaceAnchor(row);
              const cached = surfaceAnchors.get(row);
              cached.screen = null;
              if (horizon && horizon.isPointVisible(anchor) !== true)
                return null;
              const screen = services.project(state.viewer, anchor);
              if (
                !screen ||
                screen.x < 0 ||
                screen.y < 0 ||
                screen.x >= (canvas?.clientWidth ?? Infinity) ||
                screen.y >= (canvas?.clientHeight ?? Infinity)
              )
                return null;
              cached.screen = screen;
              return screen;
            }
          : null,
    });
    yield 'rank';
    badgeScreens.clear();
    for (const row of model.rows) {
      const screen = surfaceAnchors.get(row)?.screen;
      if (screen) badgeScreens.set(row.stableId, screen);
    }
    state.renderPipelineOperations = operations;
    state.renderedRows = model.rows;
    yield* updateBadgeSpacingWork();
    yield 'rank';
    state.sightingCount = state.gridAvailable
      ? Math.max(
          densityResult.sightingCount,
          model.sightingCount - model.acartiaCount,
        ) + model.acartiaCount
      : model.sightingCount;
    const previousRows = state.rowById;
    state.rowById = new Map(
      state.renderedRows.map((row) => [row.stableId, row]),
    );
    // Panning can bring two visible photo incumbents into one icon bucket.
    // Keep the single billboard winner, but preserve both card identities and
    // anchors until selection's front-side/window/height checks release them.
    const ambientAnchors = new Map();
    for (const incumbent of state.ambientRows || []) {
      const row = state.rows.get(incumbent.stableId);
      if (!row || !isRecentWildlifeSighting(row, nowMs, taxa)) continue;
      if (state.rowById.has(row.stableId)) continue;
      const old = previousRows.get(row.stableId);
      const cached = state.positions.get(row.stableId);
      ambientAnchors.set(
        row.stableId,
        cached && old?.lat === row.lat && old?.lon === row.lon
          ? cached
          : position(row),
      );
      state.rowById.set(row.stableId, row);
    }
    function restoreAmbientAnchors() {
      for (const id of ambientAnchorIds)
        if (!ambientAnchors.has(id) && !state.pointById.has(id))
          state.positions.delete(id);
      for (const [id, anchor] of ambientAnchors)
        state.positions.set(id, anchor);
      ambientAnchorIds = new Set(ambientAnchors.keys());
    }
    if (state.selectedId && !state.rowById.has(state.selectedId))
      parts.selection.clear();
    yield 'billboard-update';
    const billboardUpdate = yield* billboards.updateWork(state.renderedRows, {
      onOperations: (counts) => Object.assign(operations, counts),
    });
    yield 'overlay-publish';
    let changed = densityResult.changed;
    beginBatch();
    try {
      restoreAmbientAnchors();
      changed = stageCells(state.renderedRows) || changed;
      changed = cull() || changed;
      if (
        billboardUpdate.created ||
        billboardUpdate.removed ||
        billboardUpdate.writes
      )
        changed = true;
      if (changed) requestRender('render');
    } finally {
      endBatch();
    }
    services.performanceOperations?.(operations);
    operations = null;
    return changed;
  }

  function refreshSelection() {
    if (!state.enabled || !billboards) return false;
    // Selection changes spacing priority without reprojecting the view.
    updateBadgeSpacing();
    return cull();
  }

  function clear() {
    workQueue.cancel();
    operations = null;
    clearCells();
    density?.clear();
    billboards?.clear();
    if (state.points) state.points.show = false;
    state.pointById.clear();
    state.positions.clear();
    state.renderedRows = [];
    state.rowById.clear();
    state.sightingCount = 0;
    ambientAnchorIds.clear();
    badgeScreens.clear();
    crowdedBadgeIds.clear();
    photoCardIds.clear();
  }

  function destroy() {
    deactivate();
    clear();
    state.points?.dispose();
    state.points = null;
    state.cellSets?.fills.dispose();
    state.cellSets?.outlines.dispose();
    state.cellSets = null;
    billboards = null;
    density?.destroy();
    density = null;
    appearances.clear();
  }

  return {
    get density() {
      return density;
    },
    get pending() {
      return workQueue.pending;
    },
    init,
    activate,
    deactivate,
    occluder,
    cull,
    rebuild,
    refreshSelection,
    setPhotoCardVisibility,
    hasPhotoCard: (id) => photoCardIds.has(id),
    clear,
    destroy,
    requestRender,
    beginBatch,
    endBatch,
  };
}
