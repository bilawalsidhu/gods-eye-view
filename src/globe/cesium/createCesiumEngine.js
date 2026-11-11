// The GlobeEngine on an existing Cesium Viewer. Creating it changes nothing
// in the scene: Cesium subscriptions, the input handler and render holds
// appear only when the shell uses them, and destroy() removes them again
// (the viewer itself stays owned by the app). The one exception is the
// engine clock's frame latch on viewer.clock.onTick (clock.js), attached at
// creation so it runs before onTick listeners added later. Mover sets and
// lines join the scene in one engine-owned collection each, with the first
// set or line; ground sets join scene.groundPrimitives the same way, and
// imagery layers the imagery stack of the shown surface.

import { createCesiumCamera } from './camera.js';
import { createCesiumClock } from './clock.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumFrames } from './frames.js';
import { createCesiumMeshes } from './meshes.js';
import { createCesiumGround } from './ground.js';
import { createCesiumImagery } from './imagery.js';
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
 *   moverFactories?: object,
 *   lineFactories?: object,
 *   groundFactories?: object,
 *   imageryFactories?: object,
 *   createStage?: Function,
 *   createSonar?: Function,
 * }} [options] `requestRender` defaults to the render governor; `appClock`
 *   to the page's app clock; the `create*`/`load*` options and the mover and
 *   line, ground and imagery factories (movers.js, lines.js, ground.js,
 *   imagery.js) are test seams, `createStage` and `createSonar` too
 *   (render.js).
 *
 * `render` owns this scene's requests and continuous-render mode.
 * @returns {import('../contract.js').GlobeEngine}
 */
export function createCesiumEngine(viewer, options = {}) {
  if (!viewer?.scene) throw new TypeError('createCesiumEngine needs a viewer');
  const { canvas } = viewer;
  const render = createCesiumRender(viewer, options);
  const credits = createCesiumCredits(viewer);
  const requestRender = (reason) => render.render.request(reason);
  const movers = createCesiumMovers(viewer, {
    requestRender,
    ...(options.moverFactories ? { factories: options.moverFactories } : {}),
  });
  const lines = createCesiumLines(viewer, {
    requestRender,
    ...(options.lineFactories ? { factories: options.lineFactories } : {}),
  });
  const ground = createCesiumGround(viewer, {
    requestRender,
    ...(options.groundFactories ? { factories: options.groundFactories } : {}),
  });
  const meshes = createCesiumMeshes(viewer, { requestRender });
  const maps = createCesiumMaps(viewer, {
    ...options,
    credits: credits.credits,
    requestRender,
  });
  // Picks name the mover set, line or ground set they hit, with its pickId.
  const picker = createCesiumPicker(viewer, {
    identify: (picked) =>
      movers.identify(picked) ??
      lines.identify(picked) ??
      ground.identify(picked) ??
      meshes.identify(picked),
  });
  const parts = {
    camera: createCesiumCamera(viewer),
    picker,
    projector: createCesiumProjector(viewer),
    frames: createCesiumFrames(viewer),
    clock: createCesiumClock(viewer, options),
    movers,
    lines,
    ground,
    meshes,
    render,
    // Mover sets in a surface `exclude` are hidden for the sample.
    surface: createCesiumSurface(viewer, {
      engineExclude: (entry) =>
        movers.primitiveOf(entry) ??
        meshes.primitiveOf(entry) ??
        lines.primitiveOf(entry),
    }),
    input: createCesiumInput(viewer, { ...options, picker: picker.picker }),
    credits,
    // Before the maps: its layers leave the tilesets before they go.
    imagery: createCesiumImagery(viewer, {
      requestRender,
      tilesets: maps.tilesets,
      ...(options.imageryFactories
        ? { factories: options.imageryFactories }
        : {}),
    }),
    maps,
  };
  let destroyed = false;
  return {
    kind: 'cesium',
    // What only Cesium has, for code still written against the viewer.
    extensions: Object.freeze({ cesium: Object.freeze({ viewer }) }),
    // Cesium only, not contract: what the contact sonar holds (sonar.js),
    // live; the app reads whether its command adapter runs here.
    contactSonarDiagnostics: render.sonarDiagnostics,
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
