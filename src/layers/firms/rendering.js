import * as Cesium from 'cesium';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import { buildHeatRaster } from '../../data/firmsHeatRaster.js';
import {
  LOD_LEVELS,
  CONTEXT_TOP_N,
  HEAT_RASTER,
  HEAT_REBUILD_MS,
} from './policy.js';
import { createHeatImagery } from './heatImagery.js';

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
   * @returns {boolean} True when a rebuild actually ran. Callers use this to
   *   avoid a second horizon walk in the same tick: a rebuild already culls
   *   its freshly-added sprites, an early-out does not.
   */

  function renderCurrentLod(force = false) {
    if (
      !layerState._dataSource ||
      !layerState._fires.length ||
      !layerState._viewer
    ) {
      // A filter that leaves nothing shown must not leave the old heat behind.
      if (!layerState._fires.length) layerState._heatImagery?.setShow(false);
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
      renderHeat(lod, bounds);
    }
    return true;
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

  /** The heat imagery adapter, created on first use. */

  function heatImagery() {
    if (!layerState._heatImagery) {
      layerState._heatImagery = createHeatImagery({
        cesium: Cesium,
        getHost: () =>
          layerState._imageryHost?.() ?? {
            collection: layerState._viewer?.imageryLayers ?? null,
            kind: 'globe',
          },
      });
    }
    return layerState._heatImagery;
  }

  /** Build the heat raster from the shown set and drape it. */

  function rebuildHeatRaster() {
    clearTimeout(layerState._heatRebuildTimer);
    layerState._heatRebuildTimer = null;
    if (layerState._destroyed) return;
    layerState._heatRaster = buildHeatRaster(layerState._fires, HEAT_RASTER);
    heatImagery().setRaster(layerState._heatRaster);
  }

  /**
   * Make sure the draped heatmap matches the shown set. The first paint is
   * immediate; later rebuilds (filter drags, refreshes) trail by
   * HEAT_REBUILD_MS and keep the previous heatmap on screen meanwhile.
   */

  function ensureHeatRaster() {
    if (layerState._heatRaster) return;
    if (!heatImagery().hasRaster()) {
      rebuildHeatRaster();
      return;
    }
    clearTimeout(layerState._heatRebuildTimer);
    layerState._heatRebuildTimer = setTimeout(
      rebuildHeatRaster,
      HEAT_REBUILD_MS,
    );
  }

  /**
   * Far bands (global/regional): a Snap Map–style heatmap draped over the
   * globe, transparent where nothing burns, plus the decluttered "N FIRES"
   * cards from the coarse aggregation. No entities and no sprites are drawn;
   * cards go through the same screen-space label pipeline as detections
   * (see {@link rebuildAmbientLabels}).
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderHeat(lod, bounds) {
    ensureDetectionCollections();
    layerState._dataSource.entities.removeAll();
    if (layerState._billboards) layerState._billboards.removeAll();
    layerState._pickIndexById.clear();
    layerState._cullPositions.length = 0;

    const imagery = heatImagery();
    // The map stack may have changed since the last far render.
    imagery.rehome();
    ensureHeatRaster();
    imagery.setShow(layerState._enabled);

    const cells = aggregateFires(lod, bounds);
    layerState._cellCount = cells.length;
    layerState._labelCandidates = [];
    layerState._labelLodDistance = lod.labelDistance;

    // Cells arrive heat-sorted, so candidate order doubles as label priority.
    for (const cell of cells) {
      const centerLon = cell.lonCell + lod.gridDegrees / 2;
      const centerLat = cell.latCell + lod.gridDegrees / 2;
      layerState._labelCandidates.push({
        position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 0),
        cullPosition: components.model.cellCullPosition(centerLon, centerLat),
        fire: null,
        cell,
        accent: components.model.cellCardAccent(cell),
      });
    }

    components.cards.rebuildAmbientLabels();
    components.selection.refreshContextRegistrations(
      components.selection.topFiresWithinBounds(bounds),
    );
  }

  /**
   * Render individual detections (local/close bands) as pre-baked
   * radial-glow sprite billboards sized by FRP, capped per viewport by
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
    layerState._heatImagery?.setShow(false);
    ensureDetectionCollections();
    layerState._dataSource.entities.removeAll();
    if (!layerState._billboards) return;
    layerState._billboards.removeAll();
    layerState._pickIndexById.clear();
    layerState._cullPositions.length = 0;

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

    for (const fire of candidates) {
      const coreSize = components.model.frpPixelSize(fire.frp);
      const position = components.model.firePosition(fire);
      const cullPosition = components.model.fireCullPosition(fire);
      const pickId = `firms-${fire.index}`;
      layerState._pickIndexById.set(pickId, fire);
      layerState._cullPositions.push(cullPosition);
      layerState._billboards.add({
        id: pickId,
        position,
        image: components.model.glowSprite(
          components.model.detectionColorStop(fire),
          components.model.sizeBucket(coreSize),
        ),
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      // FRP-sorted walk: candidate order doubles as label priority.
      layerState._labelCandidates.push({
        position,
        cullPosition,
        fire,
        cell: null,
      });
    }

    // Freshly-added sprites default to show=true; cull the far side now so a
    // rebuild never flashes through-the-planet detections while the camera
    // sits still (the moveEnd/preRender hooks only fire on camera motion).
    refreshHorizonCulling();
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

  function ensureDetectionCollections() {
    if (!layerState._viewer || layerState._billboards) return;
    layerState._billboards = new Cesium.BillboardCollection({
      scene: layerState._viewer.scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    layerState._billboards.show = layerState._enabled;
    layerState._viewer.scene.primitives.add(layerState._billboards);
    registerSpriteCollection('firms', layerState._billboards);
    restoreSpriteOrder(layerState._viewer);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, layerState._enabled);
  }

  function removeDetectionCollections(viewer) {
    const scene = viewer?.scene || layerState._viewer?.scene;
    if (scene && !scene.isDestroyed?.()) {
      try {
        if (layerState._billboards)
          scene.primitives.remove(layerState._billboards);
      } catch {
        /* already torn down */
      }
    }
    layerState._billboards = null;
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

  /**
   * Hide detection sprites that sit beyond the ellipsoid horizon (see
   * {@link applyHorizonCull}). Runs on the cadences that already exist in this
   * layer — the throttled LOD preRender watcher (camera-moved only), camera
   * moveEnd, and each detection rebuild — never as a new per-frame pass.
   * No-ops in the `cells` bands, where the collection is empty.
   */

  function refreshHorizonCulling() {
    if (!layerState._billboards || !layerState._billboards.length) return;
    components.model.applyHorizonCull(
      layerState._billboards,
      fireHorizonOccluder(),
      layerState._cullPositions,
    );
  }
  return {
    renderCurrentLod,
    aggregateFires,
    renderHeat,
    renderDetections,
    ensureDetectionCollections,
    removeDetectionCollections,
    fireHorizonOccluder,
    refreshHorizonCulling,
  };
}
