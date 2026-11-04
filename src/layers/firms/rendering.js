import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { LOD_LEVELS, CONTEXT_TOP_N, GLOW_SPRITE_PX } from './policy.js';
import { createIconSet, ICON_CULL_LIFT } from '../../data/iconSet.js';
import { writeHoldSegment } from '../../data/iconSegment.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
import { iconAtlas } from '../../data/iconAtlas.js';

export function createRendering({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { warmFireAnchorFloors } = services.anchors;
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { overlayHost } = config;

  /**
   * Rebuild the render for the current LOD band and viewport. Skips work
   * when neither the (hysteresis-damped) LOD band nor the padded view
   * rectangle changed meaningfully.
   * @param {boolean} force - Rebuild even if LOD/view appear unchanged.
   * @returns {boolean} True when a rebuild actually ran.
   */

  function renderCurrentLod(force = false) {
    if (!layerState._dataSource || !layerState._viewer) return false;
    if (!layerState._fires.length) {
      // A refresh that came back empty takes down what the last one drew, so
      // no sprite or card is left on screen (and clickable) for a fire that is
      // gone.
      if (force) clearRendered();
      return false;
    }
    const lodIndex = components.viewport.selectLodIndex(
      components.viewport.cameraHeight(),
    );
    const lod = LOD_LEVELS[lodIndex];
    const viewRect = components.viewport.computeViewRect();
    if (
      !force &&
      lodIndex === layerState._currentLodIndex &&
      !components.viewport.viewChangedEnough(viewRect)
    )
      return false;
    layerState._currentLodIndex = lodIndex;
    layerState._currentLodId = lod.id;
    layerState._lastViewRect = viewRect
      ? Cesium.Rectangle.clone(viewRect)
      : null;
    const bounds = viewRect
      ? components.model.paddedDegreeBounds(viewRect)
      : null;

    if (lod.mode === 'detections') {
      renderDetections(lod, bounds);
    } else {
      renderCells(aggregateFires(lod, bounds), lod, bounds);
    }
    return true;
  }

  function clearRendered() {
    layerState._dataSource.entities.removeAll();
    layerState._icons?.clear();
    layerState._pickIndexById.clear();
    layerState._cellCount = 0;
    layerState._labelCandidates = [];
    components.cards.rebuildAmbientLabels();
    components.selection.refreshContextRegistrations([]);
  }

  /**
   * Bin all detections into grid cells, then viewport-clip BEFORE the
   * top-N cap so fires in view never lose their slot to higher-scoring
   * cells on other continents. `bounds === null` (sky/horizon or
   * near-global view) falls back to the global top-N behavior.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   * @returns {Array<Object>} Cells sorted by heat score, capped.
   */

  function aggregateFires(lod, bounds) {
    const gridDegrees = lod.gridDegrees;

    let sorted = layerState._cellCacheByGrid.get(gridDegrees);
    if (!sorted) {
      const cells = new Map();
      for (const fire of layerState._fires) {
        const latCell = Math.floor(fire.lat / gridDegrees) * gridDegrees;
        const lonCell = Math.floor(fire.lon / gridDegrees) * gridDegrees;
        const key = `${latCell.toFixed(3)}:${lonCell.toFixed(3)}`;
        // confidence is normalized 0..1 — weight ×4 preserves the old 0..100×0.04 scale.
        const intensity = Math.max(
          1,
          fire.frp * 0.18 + fire.confidence * 4 + fire.brightness * 0.01,
        );
        const existing = cells.get(key) || {
          latCell,
          lonCell,
          count: 0,
          intensity: 0,
          maxFrp: 0,
          night: 0,
          newestAcqMs: 0,
        };
        existing.count += 1;
        existing.intensity += intensity;
        existing.maxFrp = Math.max(existing.maxFrp, fire.frp);
        existing.newestAcqMs = Math.max(existing.newestAcqMs, fire.acqMs);
        if (fire.night) existing.night += 1;
        cells.set(key, existing);
      }
      // Heat-sorted once; per-render clipping below preserves the order.
      sorted = [...cells.values()].sort(
        (a, b) => components.model.heatScore(b) - components.model.heatScore(a),
      );
      layerState._cellCacheByGrid.set(gridDegrees, sorted);
    }

    if (!bounds) return sorted.slice(0, lod.maxCells);
    const clipped = [];
    for (const cell of sorted) {
      if (!components.model.cellIntersectsBounds(cell, gridDegrees, bounds))
        continue;
      clipped.push(cell);
      if (clipped.length >= lod.maxCells) break;
    }
    return clipped;
  }

  /**
   * Render aggregated heat cells (global/regional bands) as ground-clamped
   * rectangles. Cell labels do NOT live on the entities anymore — they go
   * through the same unclamped, screen-space-decluttered label pipeline as
   * detections (see {@link rebuildAmbientLabels}).
   * @param {Array<Object>} cells - Aggregated cells, heat-sorted descending.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderCells(cells, lod, bounds) {
    ensureDetectionCollections();
    layerState._dataSource.entities.removeAll();
    layerState._icons?.clear();
    layerState._pickIndexById.clear();
    layerState._cellCount = cells.length;
    const maxScore = Math.max(1, ...cells.map(components.model.heatScore));

    layerState._labelCandidates = [];
    layerState._labelLodDistance = lod.labelDistance;

    for (const cell of cells) {
      const score = components.model.heatScore(cell);
      const normalized = Math.min(1, Math.sqrt(score / maxScore));
      const alpha = 0.16 + normalized * 0.5;
      const color = components.model.heatColor(normalized, alpha);
      const centerLon = cell.lonCell + lod.gridDegrees / 2;
      const centerLat = cell.latCell + lod.gridDegrees / 2;
      const position = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0);

      layerState._dataSource.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            cell.lonCell,
            cell.latCell,
            cell.lonCell + lod.gridDegrees,
            cell.latCell + lod.gridDegrees,
          ),
          material: new Cesium.ColorMaterialProperty(color),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        position,
        properties: {
          count: cell.count,
          intensity: score,
          maxFrp: cell.maxFrp,
          night: cell.night,
        },
      });

      // Cells arrive heat-sorted, so candidate order doubles as label priority.
      // Accent is resolved here because `normalized` only exists in this walk.
      layerState._labelCandidates.push({
        position,
        cullPosition: components.model.cellCullPosition(centerLon, centerLat),
        fire: null,
        cell,
        accent: components.model.cellAccent(normalized),
      });
    }

    components.cards.rebuildAmbientLabels();
    components.selection.refreshContextRegistrations(
      components.selection.topFiresWithinBounds(bounds),
    );
  }

  /**
   * Render individual detections (local/close bands) as pre-baked
   * radial-glow sprite icons sized by FRP, capped per viewport by
   * highest FRP, depth test disabled. The 3D Tiles mesh is never sampled
   * per point; instead, the CLOSE band (where terrain parallax is actually
   * visible) batch-warms the shared cached DEM floor for its rendered
   * subset and re-renders once floors land, so anchors sit on the terrain
   * (firePosition). The local band keeps cold anchors at height 0 — at
   * ≥750 km camera height the divergence is invisible and warming a
   * continent-wide viewport would waste the DEM proxy.
   * Labels are not built here; candidates feed {@link rebuildAmbientLabels}.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderDetections(lod, bounds) {
    ensureDetectionCollections();
    layerState._dataSource.entities.removeAll();
    const set = layerState._icons;
    if (!set) return;
    layerState._pickIndexById.clear();

    let candidates;
    if (bounds) {
      // Walk the pre-sorted FRP index and early-exit at the cap — the old
      // collect-then-sort touched and sorted every in-view detection per
      // rebuild (tens of thousands mid-zoom; field-test round 1 chug).
      candidates = [];
      for (const fire of layerState._firesByFrp) {
        if (!components.model.boundsContainPoint(bounds, fire.lat, fire.lon))
          continue;
        candidates.push(fire);
        if (candidates.length >= lod.maxDetections) break;
      }
    } else {
      // Sky/horizon view: fall back to the globally strongest detections.
      candidates = layerState._firesByFrp.slice(0, lod.maxDetections);
    }

    layerState._cellCount = candidates.length;
    layerState._labelCandidates = [];
    layerState._labelLodDistance = lod.labelDistance;

    // Fires keep their rows across rebuilds: a pan that keeps a fire in view
    // rewrites nothing for it, and only rows that left the view go.
    const keep = new Set();
    for (const fire of candidates) {
      const position = components.model.firePosition(fire);
      const pickId = `firms-${fire.index}`;
      layerState._pickIndexById.set(pickId, fire);
      keep.add(pickId);
      placeFireIcon(set, pickId, fire, position);
      // FRP-sorted walk: candidate order doubles as label priority.
      layerState._labelCandidates.push({
        position,
        cullPosition: components.model.fireCullPosition(fire),
        fire,
        cell: null,
      });
    }
    for (let row = set.count - 1; row >= 0; row -= 1) {
      const pickId = set.idAt(row);
      if (!keep.has(pickId)) set.remove(pickId);
    }

    components.cards.rebuildAmbientLabels();
    components.selection.refreshContextRegistrations(
      candidates.slice(0, CONTEXT_TOP_N),
    );

    if (lod.id === 'close') {
      // Batched (chunked ≤200, sequential, session-cached) DEM warm for the
      // rendered subset; fires are static so each coarse cell resolves once
      // ever. Re-render ONLY when a floor actually landed — a failed resolve
      // reports false, so this chain terminates instead of looping against a
      // down proxy (the next camera-driven rebuild retries).
      warmFireAnchorFloors(candidates).then((warmed) => {
        if (!warmed || !layerState._enabled || !layerState._viewer) return;
        const currentLod = LOD_LEVELS[layerState._currentLodIndex];
        if (!currentLod || currentLod.mode !== 'detections') return;
        renderCurrentLod(true);
      });
    }
  }

  /**
   * A fire's glow row: drawn depth-test-free at its anchor (a detection is
   * never swallowed by terrain it sits on), with the far side of the globe
   * culled on the GPU each frame. The Cesium globe is hidden here (Google 3D
   * Tiles render the planet), so nothing writes far-side depth, and the cull
   * is what keeps fires from shining through the planet. The anchor moves
   * once, when its floor warms.
   */
  function placeFireIcon(set, pickId, fire, position) {
    let row = set.row(pickId);
    if (row < 0) {
      row = set.add(pickId, {
        layer: 'firms',
        id: pickId,
        fire: null,
        position: null,
      });
      set.setFlag(row, ICON_CULL_LIFT, true);
      set.setShown(row, true);
    }
    const meta = set.metaAt(row);
    // A refresh reuses indices, so a kept row can hold a different detection.
    if (meta.fire !== fire) {
      meta.fire = fire;
      const slot = iconAtlas.slot(
        components.model.glowSprite(components.model.detectionColorStop(fire)),
        GLOW_SPRITE_PX,
      );
      const corePx = components.model.sizeBucket(
        components.model.frpPixelSize(fire.frp),
      );
      set.setImage(row, slot, slot);
      set.setSize(row, corePx * 2, corePx * 2);
    }
    if (meta.position === position) return;
    meta.position = position;
    writeHoldSegment(set.segments, row, position, 0);
    set.segmentWritten(row);
  }

  /** The scene the icon primitive was added to. */
  let iconScene = null;

  function ensureDetectionCollections() {
    if (!layerState._viewer || layerState._icons) return;
    const epoch = Cesium.JulianDate.now();
    layerState._icons = createIconSet({ epoch });
    layerState._iconPrimitive = new IconSetPrimitive({
      set: layerState._icons,
      renderTime: () => epoch,
      requestRender: () => layerState._viewer?.scene?.requestRender?.(),
    });
    layerState._icons.show = layerState._enabled;
    iconScene = layerState._viewer.scene;
    iconScene.primitives.add(layerState._iconPrimitive);
    registerSpriteCollection('firms', layerState._iconPrimitive);
    restoreSpriteOrder(layerState._viewer);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, layerState._enabled);
  }

  /**
   * Take the icons out of the scene they were added to, whichever viewer the
   * caller tears down, and free them: a destroyed primitive left in a live
   * scene throws on its next frame.
   */
  function removeDetectionCollections() {
    const primitive = layerState._iconPrimitive;
    try {
      if (primitive && iconScene && !iconScene.isDestroyed?.())
        iconScene.primitives.remove(primitive);
    } catch {
      /* already torn down */
    }
    if (primitive && !primitive.isDestroyed()) primitive.destroy();
    iconScene = null;
    layerState._iconPrimitive = null;
    layerState._icons = null;
    overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
  }

  /**
   * Shared horizon occluder positioned at the current camera, or null when
   * there is no usable camera yet (init order / headless stubs).
   * `viewer.camera` and `viewer.scene.camera` are the SAME object in Cesium;
   * both are probed so a partial stub (either shape) still gets a real
   * occluder rather than silently degrading to "nothing is ever occluded".
   * @returns {?Cesium.EllipsoidalOccluder}
   */

  function fireHorizonOccluder() {
    const camera = layerState._viewer?.camera?.positionWC
      ? layerState._viewer.camera
      : layerState._viewer?.scene?.camera;
    if (!camera?.positionWC) return null;
    return horizonOccluder(camera);
  }

  return {
    renderCurrentLod,
    aggregateFires,
    renderCells,
    renderDetections,
    ensureDetectionCollections,
    removeDetectionCollections,
    fireHorizonOccluder,
  };
}
