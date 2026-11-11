// The Active Fires drawing on the globe contract, the same on every engine:
// - the detection glows: one sprite mover set over an atlas of the layer's
//   glow PNGs (render/sprites.js);
// - the aggregated cells: one ground cell set, filled in each cell's colour,
//   without an outline, not pickable;
// - clicks: the engine's selection dispatcher, with the pick under the click;
// - the camera, projection, view rectangle and horizon the layer reads: the
//   engine's (engine.camera, engine.projector);
// - the far-zoom heatmap: one engine.imagery layer, the heat raster as RGBA
//   bytes over the whole globe, faded by its alpha for the hand-off.

import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { LOD_LEVELS } from '../policy.js';
import { createFirmsSpriteBank } from './sprites.js';

// Above imagery layers of the default order (a pinned Recent Imagery day).
const HEAT_ORDER = 1;

const rgbaOf = (color) => [
  color?.red ?? 1,
  color?.green ?? 1,
  color?.blue ?? 1,
  color?.alpha ?? 1,
];

/**
 * The heatmap on engine.imagery: setRaster (data/firmsHeatRaster.js's
 * equirectangular RGBA over the globe; a new one replaces the image in
 * place), hasRaster, setShow (the layer on or off), setOpacity (the
 * hand-off fade, 0..1: a faded layer stays on its surface, so it comes
 * back without a gap) and destroy. The engine layer is made with the first
 * raster.
 */
function createHeatImagery(engine, id, onDestroy) {
  let layer = null,
    raster = null,
    show = true,
    opacity = 1,
    destroyed = false;
  const heat = {
    setRaster(next) {
      if (destroyed) return;
      raster = next ?? null;
      if (!raster) {
        layer?.destroy();
        layer = null;
        return;
      }
      const source = {
        kind: 'image',
        image: {
          width: raster.width,
          height: raster.height,
          data: raster.rgba,
        },
      };
      if (layer) layer.setSource(source);
      else
        layer = engine.imagery.createLayer({
          id,
          source,
          alpha: opacity,
          show,
          order: HEAT_ORDER,
        });
    },
    /** True once a raster was handed over. */
    hasRaster: () => raster !== null,
    setShow(value) {
      if (destroyed) return;
      show = Boolean(value);
      layer?.show(show);
    },
    setOpacity(value) {
      if (destroyed) return;
      opacity = Math.min(1, Math.max(0, Number(value) || 0));
      layer?.setAlpha(opacity);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      layer?.destroy();
      layer = null;
      raster = null;
      onDestroy(heat);
    },
  };
  return heat;
}

/**
 * The renderer the fire layer draws through (lifecycle.js, rendering.js).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ id?: string, loadImage?: Function, createCanvas?: Function }} [options]
 *   `loadImage` and `createCanvas` are the sprite atlas's test seams.
 */
export function createFirmsDisplay(
  engine,
  { id = 'local-firms', loadImage, createCanvas } = {},
) {
  let destroyed = false,
    visible = false,
    cellItems = [],
    cellsQueued = false,
    sprites = null,
    heat = null;
  const clickRemovers = new Set();
  const cells = engine.ground.createSet({ id: `${id}:cells`, kind: 'cell' });
  cells.show(false);
  const layerView = createEngineLayerView(engine, {
    layerId: id,
    isDestroyed: () => destroyed,
  });
  // Cells arrive one addCell at a time: one commit per batch.
  const scheduleCells = () => {
    if (cellsQueued || destroyed) return;
    cellsQueued = true;
    queueMicrotask(() => {
      cellsQueued = false;
      if (destroyed) return;
      cells.replace(cellItems);
      cells.commit();
    });
  };
  const removeSprites = () => {
    sprites?.destroy();
    sprites = null;
  };
  return {
    engine,
    view: layerView.view,
    visible: () => visible,
    viewRectangle(result) {
      const rect = engine.camera.viewRectangle();
      return rect ? Object.assign(result ?? {}, rect) : null;
    },
    /**
     * Calls `handler({ position, picked })` for every click while the layer
     * is shown, with the pick under it; returns the remover.
     */
    onClick(handler) {
      if (destroyed) return () => {};
      const remove = selectionDispatcherFor(engine).register(id, {
        owns: (pickId) => sprites?.owns(pickId) === true,
        onClick: (event) => {
          if (!destroyed && visible) handler(event);
        },
      });
      const release = () => {
        if (!clickRemovers.delete(release)) return;
        remove();
      };
      clickRemovers.add(release);
      return release;
    },
    setVisible(show) {
      if (destroyed) return;
      const next = show !== false;
      if (visible === next) return;
      visible = next;
      sprites?.setVisible(next);
      cells.show(next);
    },
    clearCells() {
      if (destroyed) return;
      cellItems = [];
      scheduleCells();
    },
    addCell({ west, south, east, north, color }) {
      if (destroyed) return null;
      const item = { west, south, east, north, fill: rgbaOf(color) };
      cellItems.push(item);
      scheduleCells();
      return item;
    },
    /** Ground cells drawn by the last commit. */
    cellCount: () => (destroyed ? 0 : cells.count()),
    ensureSprites() {
      if (destroyed) return null;
      if (!sprites) {
        sprites = createFirmsSpriteBank(engine, {
          id: `firms:${id}`,
          capacity: Math.max(
            ...LOD_LEVELS.map((lod) => lod.maxDetections ?? 0),
          ),
          ...(loadImage ? { loadImage } : {}),
          ...(createCanvas ? { createCanvas } : {}),
        });
        sprites.setVisible(visible);
      }
      return sprites.collection;
    },
    addSprite(description) {
      return destroyed || !sprites ? null : sprites.add(description);
    },
    removeSprites,
    /** The mover set drawing the glows, for tests and QA (null before any). */
    spriteSet: () => sprites?.set ?? null,
    /**
     * The far-zoom heatmap on this globe's imagery (createHeatImagery
     * above); one at a time, destroyed with the display.
     */
    createHeatImagery() {
      if (destroyed) return null;
      heat?.destroy();
      heat = createHeatImagery(engine, `${id}:heat`, (gone) => {
        if (heat === gone) heat = null;
      });
      return heat;
    },
    /** The hand-off fade: every marker at `alpha`, shown while `show`. */
    fadeSprites(alpha, show) {
      if (!destroyed) sprites?.setFade(alpha, show);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      cellItems = [];
      for (const release of [...clickRemovers]) release();
      removeSprites();
      heat?.destroy();
      cells.destroy();
      layerView.destroy();
      engine.render.request('firms-destroy');
    },
  };
}
