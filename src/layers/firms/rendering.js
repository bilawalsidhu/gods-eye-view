import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findFrame, findQuery } from '../../render/rendererOf.js';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { LOD_LEVELS, CONTEXT_TOP_N, GLOW_SPRITE_PX } from './policy.js';

/** Icon sets made so far, by every fire layer: set ids unique to each. */
let iconSets = 0;

export function createRendering({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { warmFireAnchorFloors } = services.anchors;
  const { registerSpriteSet, unregisterSpriteCollection, restoreSpriteOrder } =
    services.sprites;
  const { overlayHost } = config;

  /**
   * Rebuild the render for the current LOD band and viewport. Skips work
   * when neither the (hysteresis-damped) LOD band nor the padded view
   * rectangle changed meaningfully.
   * @param {boolean} force - Rebuild even if LOD/view appear unchanged.
   * @returns {boolean} True when a rebuild actually ran.
   */

  function renderCurrentLod(force = false) {
    if (!layerState._cells || !layerState._viewer) return false;
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
    layerState._lastViewRect = viewRect ? { ...viewRect } : null;
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

  /** Take every heat cell down (no write when there are none). */
  function clearCells() {
    if (layerState._cells?.size()) layerState._cells.clear();
  }

  /**
   * Each drawn glow's detection and anchor, by its item id: what it was last
   * written with, so a rebuild writes only the glows that changed.
   * @type {Map<string, {fire: object, position: object}>}
   */
  const drawnGlows = new Map();

  /** Take every glow down (no write when there are none). */
  function clearIcons() {
    if (!drawnGlows.size) return;
    drawnGlows.clear();
    layerState._icons?.clear();
  }

  function clearRendered() {
    clearCells();
    clearIcons();
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
   * rectangles, one draw set. Cell labels do NOT live on the cells — they go
   * through the same unclamped, screen-space-decluttered label pipeline as
   * detections (see {@link rebuildAmbientLabels}).
   * @param {Array<Object>} cells - Aggregated cells, heat-sorted descending.
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderCells(cells, lod, bounds) {
    ensureDetectionCollections();
    clearIcons();
    layerState._pickIndexById.clear();
    layerState._cellCount = cells.length;
    const maxScore = Math.max(1, ...cells.map(components.model.heatScore));

    layerState._labelCandidates = [];
    layerState._labelLodDistance = lod.labelDistance;

    const items = [];
    for (const cell of cells) {
      const score = components.model.heatScore(cell);
      const normalized = Math.min(1, Math.sqrt(score / maxScore));
      const alpha = 0.16 + normalized * 0.5;
      const color = components.model.heatColor(normalized, alpha);
      const centerLon = cell.lonCell + lod.gridDegrees / 2;
      const centerLat = cell.latCell + lod.gridDegrees / 2;
      const position = fromDegrees(centerLon, centerLat, 0);

      items.push({
        id: `firms-cell:${lod.gridDegrees}:${cell.latCell}:${cell.lonCell}`,
        geometry: {
          kind: 'rectangle',
          rect: {
            west: cell.lonCell,
            south: cell.latCell,
            east: cell.lonCell + lod.gridDegrees,
            north: cell.latCell + lod.gridDegrees,
          },
        },
        fill: color,
        height: 'clampGround',
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

    layerState._cells.set(items);
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
    clearCells();
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

    // Fires keep their glows across rebuilds: a pan that keeps a fire in
    // view rewrites nothing for it, and only glows that left the view go.
    const keep = new Set();
    const writes = [];
    for (const fire of candidates) {
      const position = components.model.firePosition(fire);
      const pickId = `firms-${fire.index}`;
      layerState._pickIndexById.set(pickId, fire);
      keep.add(pickId);
      const glow = fireGlow(pickId, fire, position);
      if (glow) writes.push({ glow, fire, position });
      // FRP-sorted walk: candidate order doubles as label priority.
      layerState._labelCandidates.push({
        position,
        cullPosition: components.model.fireCullPosition(fire),
        fire,
        cell: null,
      });
    }
    const gone = [];
    for (const pickId of drawnGlows.keys())
      if (!keep.has(pickId)) gone.push(pickId);
    for (const pickId of gone) drawnGlows.delete(pickId);
    if (gone.length) set.remove(gone);
    if (writes.length) {
      set.upsert(writes.map((write) => write.glow));
      for (const { glow, fire, position } of writes)
        drawnGlows.set(glow.id, { fire, position });
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
   * A fire's glow icon, when it is new or changed since it was last drawn
   * (else null): drawn depth-test-free at its anchor (a detection is never
   * swallowed by terrain it sits on), with the far side of the globe culled
   * by the set's horizon cull each frame. The Cesium globe is hidden here
   * (Google 3D Tiles render the planet), so nothing writes far-side depth,
   * and the cull is what keeps fires from shining through the planet. The
   * anchor moves once, when its floor warms. A refresh reuses indices, so a
   * kept id can hold a different detection, restyled then.
   *
   * The glow is rasterised once per colour at GLOW_SPRITE_PX and drawn at
   * the fire's own size by its scale. Its hold motion draws it on the
   * renderer's moving-icon path, which culls the horizon on the GPU.
   */
  function fireGlow(pickId, fire, position) {
    const drawn = drawnGlows.get(pickId);
    if (drawn && drawn.fire === fire && drawn.position === position)
      return null;
    const corePx = components.model.sizeBucket(
      components.model.frpPixelSize(fire.frp),
    );
    return {
      id: pickId,
      pos: { x: position.x, y: position.y, z: position.z },
      image: components.model.glowSprite(
        components.model.detectionColorStop(fire),
      ),
      size: [GLOW_SPRITE_PX, GLOW_SPRITE_PX],
      scale: (corePx * 2) / GLOW_SPRITE_PX,
      disableDepthTest: Infinity,
      motion: { kind: 'hold' },
      meta: { layer: 'firms', id: pickId },
    };
  }

  /** The sprite order's entry for the glow set. */
  let spriteEntry = null;

  function ensureDetectionCollections() {
    if (!layerState._viewer || layerState._icons) return;
    const set = drawOf(layerState._viewer).icons({
      id: `firms:${++iconSets}:icons`,
      horizonCull: true,
      show: layerState._enabled,
    });
    // Columns of no rows put the set's host in the scene now, where the
    // sprite order finds it, rather than with its first fire.
    set.setColumns?.({ ids: [] });
    layerState._icons = set;
    spriteEntry = registerSpriteSet('firms', set.id);
    restoreSpriteOrder(layerState._viewer);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, layerState._enabled);
  }

  /**
   * Let the glow set go, whichever viewer the caller tears down: its
   * renderer takes it out of the scene it draws in.
   */
  function removeDetectionCollections() {
    if (spriteEntry) unregisterSpriteCollection('firms', spriteEntry);
    spriteEntry = null;
    layerState._icons?.dispose();
    layerState._icons = null;
    drawnGlows.clear();
    overlayHost.clearSource(FIRMS_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, false);
  }

  /**
   * The renderer's query and frame ports the cards and the LOD watcher use:
   * the bound renderer's, or for a viewer with no
   * renderer bound, those the Cesium adapter builds over it once the
   * caller has loaded `./render/cesium/unbound` (`findQuery`, `findFrame`).
   * @returns {{query: object|null, frame: object|null}}
   */
  function scenePorts() {
    const viewer = layerState._viewer;
    return { query: findQuery(viewer), frame: findFrame(viewer) };
  }

  return {
    scenePorts,
    renderCurrentLod,
    aggregateFires,
    renderCells,
    renderDetections,
    ensureDetectionCollections,
    removeDetectionCollections,
  };
}
