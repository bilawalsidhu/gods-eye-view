// The GlobeEngine on an existing Cesium Viewer. Creating it changes nothing
// in the scene: Cesium subscriptions, the input handler and render holds
// appear only when the shell uses them, and destroy() removes them again
// (the viewer itself stays owned by the app). The one exception is the
// engine clock's frame latch on viewer.clock.onTick (clock.js), attached at
// creation so it runs before onTick listeners added later.

import { createCesiumCamera } from './camera.js';
import { createCesiumClock } from './clock.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumFrames } from './frames.js';
import { createCesiumInput } from './input.js';
import { createCesiumLines } from './lines.js';
import { createCesiumMaps } from './maps.js';
import { createCesiumMovers } from './movers.js';
import { createCesiumPicker } from './picker.js';
import { createCesiumProjector } from './projector.js';
import { createCesiumRender } from './render.js';
import { createCesiumSurface } from './surface.js';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{
 *   tilesetRef?: { current: object | null } | (() => object | null),
 *   requestRender?: (reason: string) => void,
 *   createEventHandler?: Function,
 *   createImageryLayer?: Function,
 *   loadPhotorealTileset?: Function,
 *   appClock?: import('../../time/clock.js').AppClock,
 * }} [options] `requestRender` defaults to the render governor; `appClock`
 *   to the page's app clock; the `create*`/`load*` options are test seams.
 *
 * `render.setContinuous` takes a hold on the app's singleton renderGovernor
 * (src/renderGovernor.js), which governs the one viewer it was installed on;
 * so one Cesium engine per page, on that viewer.
 * @returns {import('../contract.js').GlobeEngine}
 */
export function createCesiumEngine(viewer, options = {}) {
  if (!viewer?.scene) throw new TypeError('createCesiumEngine needs a viewer');
  // Viewer.canvas is scene.canvas; the engine reads the public alias.
  const canvas = viewer.canvas ?? viewer.scene.canvas;
  const render = createCesiumRender(viewer, options);
  const credits = createCesiumCredits(viewer);
  // Picks name the mover set or line they hit (movers and lines exist
  // below; the picker asks them when it picks).
  let lines = null;
  let movers = null;
  let projectorPart = null;
  const picker = createCesiumPicker(viewer, {
    identify: (picked) =>
      movers?.identify(picked) ?? lines?.identify(picked) ?? null,
    // A mover instance behind the globe is not picked (billboards drawn
    // without a depth test reach Cesium's GPU pick through it).
    visible: ({ owner, instance }) => {
      const position = movers?.instancePosition(owner, instance);
      return position ? projectorPart.projector.horizonVisible(position) : true;
    },
  });
  const parts = {
    camera: createCesiumCamera(viewer),
    picker,
    projector: (projectorPart = createCesiumProjector(viewer)),
    frames: createCesiumFrames(viewer),
    clock: createCesiumClock(viewer, options),
    lines: (lines = createCesiumLines(viewer, {
      requestRender: (reason) => render.render.request(reason),
      ...(options.lineFactories ? { factories: options.lineFactories } : {}),
    })),
    movers: (movers = createCesiumMovers(viewer, {
      requestRender: (reason) => render.render.request(reason),
      ...(options.moverFactories ? { factories: options.moverFactories } : {}),
    })),
    render,
    // Mover sets in a surface `exclude` are hidden for the sample.
    surface: createCesiumSurface(viewer, {
      engineExclude: (entry) => movers?.primitiveOf(entry) ?? null,
    }),
    input: createCesiumInput(viewer, { ...options, picker: picker.picker }),
    credits,
    maps: createCesiumMaps(viewer, {
      ...options,
      credits: credits.credits,
      requestRender: (reason) => render.render.request(reason),
    }),
  };
  let destroyed = false;
  return {
    kind: 'cesium',
    host: {
      container: viewer.container,
      canvas,
      size: () => ({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      }),
    },
    ...Object.fromEntries(
      Object.entries(parts).map(([name, part]) => [name, part[name]]),
    ),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const part of Object.values(parts)) part.destroy();
    },
    isDestroyed: () => destroyed,
  };
}
