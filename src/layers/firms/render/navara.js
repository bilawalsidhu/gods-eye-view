// FIRMS terrain/tiles classification and actual engine mover glows.
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { LOD_LEVELS } from '../policy.js';
import { createFirmsSpriteBank } from './navaraSprites.js';
import { createGroundCellDisplay } from '../../shared/render/navaraGroundCells.js';
export function createFirmsNavaraRenderer(
  engine,
  { view: nativeView, EffectDesc, NavaraEffect, id = 'local-firms' } = {},
) {
  if (!engine?.movers || !nativeView?.camera || !EffectDesc || !NavaraEffect)
    throw new TypeError('FIRMS requires a Navara view');
  const display = createGroundCellDisplay(
    engine,
    { view: nativeView, EffectDesc, NavaraEffect },
    1,
  );
  let destroyed = false,
    visible = false,
    cells = [],
    queued = false,
    sprites = null;
  const dataSource = { show: false },
    handlers = new Set();
  const adapter = createEngineLayerView(engine, {
    layerId: id,
    isDestroyed: () => destroyed,
  });
  adapter.view.camera.moveEnd = engine.camera.moveEnd;
  adapter.view.scene.preRender = engine.frames.preRender;
  const scheduleCells = () => {
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (destroyed) return;
      display.replace(cells);
    });
  };
  const removeSprites = () => {
    sprites?.destroy();
    sprites = null;
  };
  return {
    kind: 'navara',
    view: adapter.view,
    dataSource,
    clickType: 'click',
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    viewRectangle(result) {
      const rect = engine.camera.viewRectangle();
      return rect ? Object.assign(result ?? {}, rect) : null;
    },
    horizon: () => ({
      isPointVisible: (position) => engine.projector.horizonVisible(position),
    }),
    createInputHandler() {
      let remove = null;
      const handler = {
        setInputAction(callback) {
          remove?.();
          remove = selectionDispatcherFor(engine).register(id, {
            owns: (pickId) => {
              const collection = sprites?.collection;
              if (!collection) return false;
              for (let i = 0; i < collection.length; i++)
                if (collection.get(i).id === pickId) return true;
              return false;
            },
            onClick: (event) => {
              if (!destroyed && visible) callback(event);
            },
          });
        },
        destroy() {
          remove?.();
          remove = null;
          handlers.delete(handler);
        },
      };
      handlers.add(handler);
      return handler;
    },
    pick: (position, event) => event?.picked,
    setVisible(show) {
      if (destroyed) return;
      const next = show !== false;
      if (visible === next) return;
      visible = next;
      dataSource.show = next;
      sprites?.setVisible(next);
      display.setVisible(visible);
      engine.render.request('firms-visibility');
    },
    clearCells() {
      if (destroyed) return;
      cells = [];
      scheduleCells();
    },
    addCell(cell) {
      if (destroyed) return null;
      cells.push(cell);
      scheduleCells();
      return cell;
    },
    ensureSprites() {
      if (destroyed) return null;
      if (!sprites) {
        sprites = createFirmsSpriteBank(engine, {
          id: `firms:${id}`,
          capacity: Math.max(
            ...LOD_LEVELS.map((lod) => lod.maxDetections ?? 0),
          ),
        });
        sprites.setVisible(visible);
      }
      return sprites.collection;
    },
    addSprite(description) {
      return destroyed ? null : sprites.add(description);
    },
    removeSprites,
    onEnable() {},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      dataSource.show = false;
      cells = [];
      for (const handler of [...handlers]) handler.destroy();
      removeSprites();
      display.destroy();
      adapter.destroy();
      engine.render.request('firms-destroy');
    },
  };
}
