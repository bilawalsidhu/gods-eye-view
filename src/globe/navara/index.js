// The Navara globe for the app's experimental engine mode: builds the view
// the product way (viewOptions.js) and the GlobeEngine on it. Load it with a
// dynamic import() so Navara stays out of the Cesium-mode bundle.

import ThreeView from '@navaramap/three';
import * as geo from '../../geo/index.js';
import { DefaultPlugin } from '@navaramap/three-default-plugin';
import { createNavaraEngine } from './createNavaraEngine.js';
import {
  forEachLuminanceUniform,
  keepCascadedLightIds,
  navaraHooks,
} from './internals.js';
import { buildNavaraLook } from './look.js';
import { createNavaraSharpen } from './sharpen.js';
import { createNavaraMovers } from './movers/index.js';
import { createNavaraLines } from './lines/index.js';
import {
  NAVARA_CONTEXT_ATTRIBUTES,
  navaraScenePlan,
  navaraViewOptions,
  resolveNavaraLook,
} from './viewOptions.js';

// Navara 0.2.1 has no preserveDrawingBuffer option but takes a canvas whose
// WebGL2 context is already created (S4); three then uses that context.
function preservedCanvas(container) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, {
    width: '100%',
    height: '100%',
    display: 'block',
  });
  container.appendChild(canvas);
  if (!canvas.getContext('webgl2', NAVARA_CONTEXT_ATTRIBUTES)) {
    canvas.remove();
    throw new Error('WebGL2 is not available');
  }
  return canvas;
}

// The camera's place for the look, refreshed in place each frame (no
// allocation): degrees for the sun's elevation, and the height.
const lookCarto = { longitude: 0, latitude: 0, height: 0 };
const lookPlace = { lat: 0, lng: 0 };

/** Fills lookPlace from the camera; false while it has no position yet. */
function readCameraPlace(camera) {
  const place = geo.cartographic.fromCartesian(
    camera.livePosition,
    geo.ellipsoid.WGS84,
    lookCarto,
  );
  if (!place) return false;
  lookPlace.lat = geo.math.toDegrees(place.latitude);
  lookPlace.lng = geo.math.toDegrees(place.longitude);
  return true;
}

// The height of the ground in view, for the look's cloud rule: the depth of
// the last drawn frame halfway down the lower half (the near ground, not the
// horizon: over a canyon the rim, not the far floor). A depth read stalls for
// 1.5 to 4 ms, so it runs only when the camera comes to rest (and once more
// when the tiles in view have loaded).
function groundInView(engine) {
  const { width, height } = engine.host.size();
  const point = engine.picker.pickPosition({
    x: width / 2,
    y: height * 0.75,
  });
  const place =
    point && geo.cartographic.fromCartesian(point, geo.ellipsoid.WGS84);
  return place ? place.height : Number.NaN;
}

/**
 * @param {{
 *   container: HTMLElement,
 *   effects?: 'minimal' | 'photoreal' | 'cinematic',
 *   search?: string,
 *   pixelRatio?: number,
 *   appClock?: import('../../time/clock.js').AppClock,
 * }} options `effects` names the look (cinematic by default); `search`, the
 *   page's query string, picks it from `?look=` instead (the app's way).
 *   `pixelRatio` only for measurements; the product uses the device's.
 *   `appClock` (the page's by default) is the engine clock's time and so the
 *   sun's: the look reads the engine clock's frame time.
 * @returns {Promise<{ view: object, engine: import('../contract.js').GlobeEngine, destroy: () => void }>}
 */
export async function createNavaraGlobe({
  container,
  effects,
  search,
  pixelRatio,
  appClock,
}) {
  if (!container) throw new TypeError('createNavaraGlobe needs a container');
  const canvas = preservedCanvas(container);
  let view;
  let engine;
  let removeLook = null;
  try {
    view = new ThreeView(navaraViewOptions({ container, canvas, pixelRatio }));
    const plugin = new DefaultPlugin();
    view.addPlugin(plugin);
    await view.init();
    const plan = navaraScenePlan(effects ?? resolveNavaraLook(search), {
      mobile: Boolean(view.isMobileOptimized?.()),
    });
    // The sun follows the engine clock (one time source for layers and the
    // look); the look only runs in preRender, after the engine exists.
    const look = buildNavaraLook(
      view,
      plugin,
      plan,
      () => engine.clock.frameTime(),
      { forEachLuminanceUniform },
    );
    // The look's shadowed sun leaked a light per frame (internals.js).
    keepCascadedLightIds(view);
    engine = createNavaraEngine(view, {
      hooks: navaraHooks(view),
      container,
      ...(appClock ? { appClock } : {}),
      sharpen: createNavaraSharpen(view),
      movers: createNavaraMovers(view),
      lines: createNavaraLines(view),
    });
    const camera = engine.camera;
    let ground = Number.NaN;
    // Whether `ground` was read from a frame with all its tiles: a read
    // while they stream in is taken again once they have loaded.
    let groundSettled = false;
    const readGround = () => {
      groundSettled = engine.surface.tilesLoaded();
      ground = groundInView(engine);
    };
    let moving = false;
    const removers = [
      camera.moveStart.addEventListener(() => {
        moving = true;
      }),
      camera.moveEnd.addEventListener(() => {
        moving = false;
        readGround();
        engine.render.request('navara-look');
      }),
      // After the engine's camera sync: before the first frame the camera
      // has no position yet (camera.height() throws).
      engine.frames.preRender.addEventListener(() => {
        if (!moving && !groundSettled && engine.surface.tilesLoaded())
          readGround();
        const placed = readCameraPlace(camera);
        if (
          look.frame(
            placed ? lookCarto.height : Number.NaN,
            moving,
            ground,
            placed ? lookPlace : null,
          )
        )
          engine.render.request('navara-look');
      }),
    ];
    removeLook = () => removers.forEach((remove) => remove());
  } catch (error) {
    removeLook?.();
    engine?.destroy();
    view?.dispose();
    canvas.remove();
    throw error;
  }
  let destroyed = false;
  return {
    view,
    engine,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeLook();
      engine.destroy();
      view.dispose();
      canvas.remove();
    },
  };
}
