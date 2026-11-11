// The Navara globe for the app's experimental engine mode: builds the view
// the product way (viewOptions.js) and the GlobeEngine on it. Load it with a
// dynamic import() so Navara stays out of the Cesium-mode bundle.
import { worldClock, worldTimeFor } from '../../time/worldClock.js';

import ThreeView, { Color as NavaraColor, MeshDesc } from '@navaramap/three';
import * as geo from '../../geo/index.js';
import { DefaultPlugin } from '@navaramap/three-default-plugin';
import { Pass } from 'postprocessing';
import { createNavaraEngine } from './createNavaraEngine.js';
import {
  forEachLuminanceUniform,
  keepCascadedLightIds,
  navaraHooks,
  setRenderLoopEnabled,
} from './internals.js';
import { buildNavaraLook } from './look.js';
import { createNavaraSharpen } from './sharpen.js';
import { createNavaraStyles } from './stylePasses.js';
import { createNavaraBloom } from './bloom.js';
import { createNavaraCloudCover } from './cockpitClouds.js';
import { createNavaraSonar } from './sonar.js';
import { retroShader } from '../../styles/retro.js';
import { nightVisionShader } from '../../styles/surveillance.js';
import { thermalShader } from '../../styles/thermal.js';
import { animeShader } from '../../styles/anime.js';
import { noirShader } from '../../styles/noir.js';
import { createNavaraMovers } from './movers/index.js';
import { createNavaraLines } from './lines/index.js';
import { createNavaraMeshes } from './meshes.js';
import { createNavaraGround } from './ground/index.js';
import { createNavaraPulseField } from './ground/pulse.js';
import { createGroundPass } from './ground/pass.js';
import { createNavaraImagery } from './imagery/index.js';
import { createImageryPass } from './imagery/pass.js';
import { createNavaraOverlay } from './overlay.js';
import { createPostSampling } from './postSampling.js';
import {
  NAVARA_CONTEXT_ATTRIBUTES,
  ACES_FILMIC,
  navaraScenePlan,
  navaraViewOptions,
  resolveNavaraLook,
} from './viewOptions.js';

// Navara 0.2.1 has no preserveDrawingBuffer option but takes a canvas whose
// WebGL2 context is already created; three then uses that context.
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

// The app's styles by their names, in Cesium's stage order
// (src/ui/visualPresets.js STYLES).
const STYLE_SHADERS = Object.freeze({
  retro: retroShader,
  surveillance: nightVisionShader,
  thermal: thermalShader,
  anime: animeShader,
  noir: noirShader,
});

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
 *   search?: string,
 *   hd?: boolean,
 * }} options `search`, the page's query string, picks the look from
 *   `?look=` (cinematic by default); `hd` draws at the device pixel ratio
 *   with MSAA (Navara HD), else at CSS pixels without it. The sun follows the world time.
 * @returns {Promise<{ setRenderLoop: (enabled: boolean) => void, engine: import('../contract.js').GlobeEngine, destroy: () => void }>}
 */
export async function createNavaraGlobe({ container, search, hd = false }) {
  if (!container) throw new TypeError('createNavaraGlobe needs a container');
  const canvas = preservedCanvas(container);
  let view;
  let engine;
  let overlay = null;
  let look;
  let removeLook = null;
  let removePostSampling = null;
  // Parked for a switch back: its render loop is off (setRenderLoop).
  let parked = false;
  try {
    view = new ThreeView(navaraViewOptions({ container, canvas, hd }));
    const plugin = new DefaultPlugin();
    view.addPlugin(plugin);
    await view.init();
    const automaticLandscape =
      new URLSearchParams(search).get('sun') !== 'live';
    const plan = navaraScenePlan(resolveNavaraLook(search), {
      mobile: Boolean(view.isMobileOptimized?.()),
    });
    // The sky follows the timeline; live feeds keep the engine's app clock.
    look = buildNavaraLook(view, plugin, plan, worldTimeFor('sky'), {
      forEachLuminanceUniform,
    });
    // The look's shadowed sun leaked a light per frame (internals.js).
    keepCascadedLightIds(view);
    removePostSampling = createPostSampling(view);
    // Screen overlays and model display colour after tone mapping (overlay.js).
    overlay = createNavaraOverlay(view);
    engine = createNavaraEngine(view, {
      hooks: navaraHooks(view),
      container,
      sharpen: createNavaraSharpen(view),
      bloom: createNavaraBloom(view),
      clouds: createNavaraCloudCover(look),
      sonar: createNavaraSonar(view),
      styles: createNavaraStyles(view, {
        shaders: STYLE_SHADERS,
        onStarsDimmed: (amount) => look.setStarsDimmed(amount),
      }),
      movers: createNavaraMovers(view, {
        overlay,
        // Model colour follows the display-space stage, after the look's ACES.
        aces: plan.effects.some(
          ({ toneMapping }) => toneMapping?.mode === ACES_FILMIC,
        ),
      }),
      lines: createNavaraLines(view, { overlay }),
      meshes: (parts) => createNavaraMeshes(view, { overlay, ...parts }),
      ground: createNavaraGround(view, {
        createPass: createGroundPass,
        pulseField: (options) =>
          createNavaraPulseField({ view, canvas }, options),
      }),
      imagery: (parts) =>
        createNavaraImagery(view, { ...parts, createPass: createImageryPass }),
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
        // A parked globe (setRenderLoop(false)) draws nothing: its camera
        // settling asks for no frame.
        if (!parked) engine.render.request('navara-look');
      }),
      // After the engine's camera sync: before the first frame the camera
      // has no position yet (camera.height() throws).
      engine.frames.preRender.addEventListener(() => {
        if (!moving && !groundSettled && engine.surface.tilesLoaded())
          readGround();
        const placed = readCameraPlace(camera);
        const landscape =
          placed &&
          plan.globeLighting &&
          automaticLandscape &&
          worldClock.isLive() &&
          (engine.maps.baseKind === 'sentinel2' ||
            engine.maps.baseKind === 'esri-imagery');
        if (container.hasAttribute('data-terrain-daylight') !== landscape)
          container.toggleAttribute('data-terrain-daylight', landscape);
        if (
          look.frame(
            placed ? lookCarto.height : Number.NaN,
            moving,
            ground,
            placed ? lookPlace : null,
            landscape,
          ) &&
          !parked
        )
          engine.render.request('navara-look');
      }),
    ];
    // Navara's tile budget counts the screen-sized render targets too, which
    // it reports only after drawing them, so the budget follows them (a fixed
    // total coarsened the view on a 2x screen). The room for tiles over them
    // is Navara's device default: a quarter of device memory, at most 2 GiB
    // (less on phones). An oblique view needs about 0.9 GiB of tiles at
    // 960x640 and 1.2 GiB at 1440x900; over budget Navara stops refining, so
    // a smaller room left the imagery about two levels coarse.
    const tileRoom = view.cacheBytes;
    let fixedGpuBytes = 0;
    let budgetedAt = -Infinity;
    removers.push(
      engine.frames.postRender.addEventListener(() => {
        const now = performance.now();
        if (now - budgetedAt < 1000) return;
        budgetedAt = now;
        const fixed = view.memoryStats()?.fixedGpuBytes ?? 0;
        if (fixed <= 0 || fixed === fixedGpuBytes) return;
        fixedGpuBytes = fixed;
        view.cacheBytes = fixed + tileRoom;
      }),
    );
    removeLook = () => removers.forEach((remove) => remove());
  } catch (error) {
    removeLook?.();
    removePostSampling?.();
    engine?.destroy();
    overlay?.destroy();
    view?.dispose();
    canvas.remove();
    throw error;
  }
  let destroyed = false;
  // What only Navara has, for the code written against Navara itself (its
  // layer renderers): the view, the SDK classes and the daylight reset.
  engine.extensions = Object.freeze({
    navara: Object.freeze({
      view,
      MeshDesc,
      NavaraColor,
      alignDaylightToRestoredView() {
        look.resetDaylight();
        engine.render.request('restored-daylight');
      },
    }),
  });
  return {
    engine,
    setRenderLoop: (enabled) => {
      parked = !enabled;
      setRenderLoopEnabled(view, enabled);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      container.removeAttribute('data-terrain-daylight');
      removeLook();
      removePostSampling();
      engine.destroy();
      overlay.destroy();
      view.dispose();
      // postprocessing's fullscreen triangle is one module-level geometry:
      // every renderer that drew it left a 'dispose' listener holding its GL
      // state, which pins this canvas and the whole view. Disposing it drops
      // those listeners; the next view uploads it again.
      Pass.fullscreenGeometry.dispose();
      canvas.remove();
    },
  };
}
