// The GlobeEngine on an existing Cesium Viewer. Creating it changes nothing
// in the viewer: Cesium subscriptions, the input handler and render holds
// appear only when the shell uses them, and destroy() removes them again
// (the viewer itself stays owned by the app).

import { createCesiumCamera } from './camera.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumFrames } from './frames.js';
import { createCesiumInput } from './input.js';
import { createCesiumMaps } from './maps.js';
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
 * }} [options] `requestRender` defaults to the render governor; the
 *   `create*`/`load*` options are test seams.
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
  const parts = {
    camera: createCesiumCamera(viewer),
    picker: createCesiumPicker(viewer),
    projector: createCesiumProjector(viewer),
    frames: createCesiumFrames(viewer),
    render,
    surface: createCesiumSurface(viewer),
    input: createCesiumInput(viewer, options),
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
  };
}
