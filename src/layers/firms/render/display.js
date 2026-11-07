// The Active Fires drawing on the globe contract, the same on every engine:
// - the detection glows: one sprite mover set over an atlas of the layer's
//   glow PNGs (render/sprites.js);
// - the aggregated cells: one ground cell set, filled in each cell's colour,
//   without an outline, not pickable;
// - clicks: the engine's selection dispatcher, with the pick under the click;
// - the camera, projection, view rectangle and horizon the layer reads: the
//   engine's (engine.camera, engine.projector).
// The far-zoom heatmap is a draped raster, which the contract has no
// primitive for; it sits behind render/heatField.js.

import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { LOD_LEVELS } from '../policy.js';
import { createFirmsSpriteBank } from './sprites.js';
import { createFirmsHeatField } from './heatField.js';

const rgbaOf = (color) => [
  color?.red ?? 1,
  color?.green ?? 1,
  color?.blue ?? 1,
  color?.alpha ?? 1,
];

/**
 * The renderer the fire layer draws through (lifecycle.js, rendering.js).
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ id?: string, navaraHeat?: Function, loadImage?: Function,
 *   createCanvas?: Function }} [options] `navaraHeat` is the heatmap's Navara
 *   backend (render/navaraHeat.js), which the Navara mode passes in;
 *   `loadImage` and `createCanvas` are the sprite atlas's test seams.
 */
export function createFirmsDisplay(
  engine,
  { id = 'local-firms', navaraHeat, loadImage, createCanvas } = {},
) {
  if (!engine?.movers || !engine?.ground)
    throw new TypeError('The FIRMS display needs a globe engine');
  let destroyed = false,
    visible = false,
    cellItems = [],
    cellsQueued = false,
    sprites = null;
  // The layer's visibility as the context store reads a data source's.
  const dataSource = { show: false };
  const clickRemovers = new Set();
  const cells = engine.ground.createSet({ id: `${id}:cells`, kind: 'cell' });
  cells.show(false);
  const layerView = createEngineLayerView(engine, {
    layerId: id,
    isDestroyed: () => destroyed,
  });
  // The camera and scene events the layer's watchers listen to.
  layerView.view.camera.moveEnd = engine.camera.moveEnd;
  layerView.view.scene.preRender = engine.frames.preRender;
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
    view: layerView.view,
    dataSource,
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    viewRectangle(result) {
      const rect = engine.camera.viewRectangle();
      return rect ? Object.assign(result ?? {}, rect) : null;
    },
    horizon: () => ({
      isPointVisible: (position) => engine.projector.horizonVisible(position),
    }),
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
      dataSource.show = next;
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
     * The far-zoom heatmap draped on this globe (render/heatField.js): on
     * Cesium on the active map stack's imagery host (`imageryHost()`), else
     * on the viewer's imagery layers.
     */
    createHeatImagery(imageryHost) {
      return destroyed
        ? null
        : createFirmsHeatField(engine, { imageryHost, navaraHeat });
    },
    /** The hand-off fade: every marker at `alpha`, shown while `show`. */
    fadeSprites(alpha, show) {
      if (!destroyed) sprites?.setFade(alpha, show);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      dataSource.show = false;
      cellItems = [];
      for (const release of [...clickRemovers]) release();
      removeSprites();
      cells.destroy();
      layerView.destroy();
      engine.render.request('firms-destroy');
    },
  };
}
