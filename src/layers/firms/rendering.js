import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  drawOf,
  findFrame,
  findGlobe,
  findQuery,
} from '../../render/rendererOf.js';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { buildHeatRaster } from '../../data/firmsHeatRaster.js';
import {
  LOD_LEVELS,
  CONTEXT_TOP_N,
  GLOW_SPRITE_PX,
  HANDOFF_FADE,
  HEAT_RASTER,
  HEAT_REBUILD_MS,
} from './policy.js';
import { createHeatImagery } from './heatImagery.js';

/** Icon sets made so far, by every fire layer: set ids unique to each. */
let iconSets = 0;

/** The markers drawn under the far bands' heatmap for the hand-off fade. */
const HANDOFF_MARKER_LOD = LOD_LEVELS.find((lod) => lod.mode === 'detections');

/** Fade steps: a moving camera rewrites marker opacity at most this often. */
const FADE_STEPS = 32;

export function createRendering({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { warmFireAnchorFloors } = services.anchors;
  const { spriteDrawOrder } = services.sprites;
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
      // A filter that leaves nothing shown must not leave the old heat behind.
      layerState._heatImagery?.setShow(false);
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

    renderBand(lod, bounds);
    return true;
  }

  /**
   * Draw one band. Markers and heatmap stay built in every band; the
   * hand-off only fades between them.
   * @param {Object} lod - Band descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderBand(lod, bounds) {
    prepareHeat(lod.mode === 'heat');
    if (lod.mode === 'detections') renderDetections(lod, bounds);
    else renderHeat(lod, bounds);
    applyHandoffFade(true);
  }

  /** The opacity the drawn glows were last written with. */
  let glowAlpha = 1;

  /**
   * Cross-fade between markers and heatmap by camera height (HANDOFF_FADE),
   * on every rendered frame, so a fast zoom never outruns the throttled band
   * check. Cheap when nothing changed: one height read and a compare.
   * @param {boolean} [force] Reapply, e.g. to freshly added markers.
   */

  function applyHandoffFade(force = false) {
    const height = components.viewport.cameraHeight();
    const t = Math.min(
      1,
      Math.max(
        0,
        (height - HANDOFF_FADE.from) / (HANDOFF_FADE.to - HANDOFF_FADE.from),
      ),
    );
    const heat = Math.round(t * t * (3 - 2 * t) * FADE_STEPS) / FADE_STEPS;
    if (!force && heat === layerState._handoffHeat) return;
    layerState._handoffHeat = heat;
    layerState._heatImagery?.setOpacity(heat);
    // Glows written from here on carry the fade (fireGlow); those already
    // drawn are rewritten only when it changed.
    const alpha = 1 - heat;
    const changed = alpha !== glowAlpha;
    glowAlpha = alpha;
    const set = layerState._icons;
    if (!set) return;
    set.show = layerState._enabled && heat < 1;
    if (!changed || !drawnGlows.size) return;
    const faded = [];
    for (const drawn of drawnGlows.values()) {
      drawn.glow = { ...drawn.glow, alpha };
      faded.push(drawn.glow);
    }
    set.upsert(faded);
  }

  /**
   * Each drawn glow's detection, anchor and item, by its item id: what it
   * was last written with, so a rebuild writes only the glows that changed.
   * @type {Map<string, {fire: object, position: object, glow: object}>}
   */
  const drawnGlows = new Map();

  /** Take every glow down (no write when there are none). */
  function clearIcons() {
    if (!drawnGlows.size) return;
    drawnGlows.clear();
    layerState._icons?.clear();
  }

  function clearRendered() {
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

  /** The heat imagery adapter, created on first use. */

  function heatImagery() {
    if (!layerState._heatImagery) {
      layerState._heatImagery = createHeatImagery({
        // Draped through the renderer's globe port, on the surface the
        // active map stack draws (the shell's imagery host names it; without
        // a shell, the globe).
        getHost: () => ({
          globe: findGlobe(layerState._viewer),
          kind: layerState._imageryHost?.()?.kind ?? 'globe',
        }),
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
   * Make sure the draped heatmap matches the shown set. The first paint in a
   * far band is immediate; other builds (filter drags, refreshes, the
   * preload under the markers) trail by HEAT_REBUILD_MS and keep the
   * previous heatmap on screen meanwhile.
   * @param {boolean} now Build at once when nothing is draped yet.
   */

  function ensureHeatRaster(now) {
    if (layerState._heatRaster) return;
    if (now && !heatImagery().hasRaster()) {
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
   * Keep the heatmap draped on the current map stack and current with the
   * shown set in every band; the hand-off fade decides how much of it shows.
   * @param {boolean} now The camera is in a far band.
   */

  function prepareHeat(now) {
    const imagery = heatImagery();
    // The map stack may have changed since the last render.
    imagery.rehome();
    ensureHeatRaster(now);
    imagery.setShow(layerState._enabled);
  }

  /**
   * Far bands (global/regional): a Snap Map–style heatmap draped over the
   * globe, transparent where nothing burns, plus the decluttered "N FIRES"
   * cards from the coarse aggregation. The nearest band's markers are kept
   * built underneath for the hand-off fade and hidden once it completes;
   * cards go through the same screen-space label pipeline as detections
   * (see {@link rebuildAmbientLabels}).
   * @param {Object} lod - Active LOD descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   */

  function renderHeat(lod, bounds) {
    paintMarkers(HANDOFF_MARKER_LOD, bounds);

    const cells = aggregateFires(lod, bounds);
    layerState._cellCount = cells.length;
    layerState._labelCandidates = [];
    layerState._labelLodDistance = lod.labelDistance;

    // Cells arrive heat-sorted, so candidate order doubles as label priority.
    for (const cell of cells) {
      const centerLon = cell.lonCell + lod.gridDegrees / 2;
      const centerLat = cell.latCell + lod.gridDegrees / 2;
      layerState._labelCandidates.push({
        position: fromDegrees(centerLon, centerLat, 0),
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
    const markers = paintMarkers(lod, bounds);
    if (!markers) return;
    const candidates = markers.map((marker) => marker.fire);

    layerState._cellCount = candidates.length;
    // FRP-sorted walk: marker order doubles as label priority.
    layerState._labelCandidates = markers;
    layerState._labelLodDistance = lod.labelDistance;

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
   * The glow-sprite markers for a detections band: the strongest fires in
   * view, capped at the band's maxDetections. The set culls the far side of
   * the globe itself (`horizonCull`).
   * @param {Object} lod - Detections band descriptor.
   * @param {?Object} bounds - Padded view bounds in degrees, or null.
   * @returns {?Array<Object>} Label candidates for the fires drawn,
   *   strongest first; null before the icon set exists.
   */

  function paintMarkers(lod, bounds) {
    ensureDetectionCollections();
    const set = layerState._icons;
    if (!set) return null;
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

    const markers = [];
    // Only the close band warms terrain floors (renderDetections).
    const anchor =
      lod.id === 'close'
        ? components.model.firePosition
        : components.model.fireBuiltPosition;
    // Fires keep their glows across rebuilds: a pan that keeps a fire in
    // view rewrites nothing for it, and only glows that left the view go.
    const keep = new Set();
    const writes = [];
    for (const fire of candidates) {
      const position = anchor(fire);
      const cullPosition = components.model.fireCullPosition(fire, position);
      const pickId = `firms-${fire.index}`;
      layerState._pickIndexById.set(pickId, fire);
      keep.add(pickId);
      const glow = fireGlow(pickId, fire, position);
      if (glow) writes.push({ glow, fire, position });
      markers.push({ position, cullPosition, fire, cell: null });
    }
    const gone = [];
    for (const pickId of drawnGlows.keys())
      if (!keep.has(pickId)) gone.push(pickId);
    for (const pickId of gone) drawnGlows.delete(pickId);
    if (gone.length) set.remove(gone);
    if (writes.length) {
      set.upsert(writes.map((write) => write.glow));
      for (const { glow, fire, position } of writes)
        drawnGlows.set(glow.id, { fire, position, glow });
    }
    return markers;
  }

  /**
   * A fire's glow icon, when it is new or changed since it was last drawn
   * (else null): drawn depth-test-free at its anchor (a detection is never
   * swallowed by terrain it sits on), with the far side of the globe culled
   * by the set's horizon cull each frame. The Cesium globe is hidden here
   * (Google 3D Tiles render the planet), so nothing writes far-side depth,
   * and the cull is what keeps fires from shining through the planet. The
   * anchor moves once, when its floor warms. A refresh reuses indices, so a
   * kept id can hold a different detection, restyled then. It is written at
   * the hand-off fade's current opacity (applyHandoffFade).
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
      alpha: glowAlpha,
      disableDepthTest: Infinity,
      motion: { kind: 'hold' },
      meta: { layer: 'firms', id: pickId },
    };
  }

  function ensureDetectionCollections() {
    if (!layerState._viewer || layerState._icons) return;
    const set = drawOf(layerState._viewer).icons({
      id: `firms:${++iconSets}:icons`,
      // Blended as one translucent pass, as its billboards were.
      blend: 'translucent',
      horizonCull: true,
      show: layerState._enabled && !(layerState._handoffHeat >= 1),
      drawOrder: spriteDrawOrder?.('firms') ?? 0,
    });
    // Columns of no rows put the set's host in the scene now, rather than
    // with its first fire.
    set.setColumns?.({ ids: [] });
    layerState._icons = set;
    overlayHost.setVisible(FIRMS_OVERLAY_SOURCE_ID, layerState._enabled);
  }

  /**
   * Let the glow set go, whichever viewer the caller tears down: its
   * renderer takes it out of the scene it draws in.
   */
  function removeDetectionCollections() {
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
    renderBand,
    aggregateFires,
    renderHeat,
    renderDetections,
    applyHandoffFade,
    ensureDetectionCollections,
    removeDetectionCollections,
  };
}
