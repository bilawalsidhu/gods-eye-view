/**
 * @module render/cesium/harness
 * @description The Cesium renderer as the conformance suite's renderer under
 * test, in the `/dev/conformance/` page.
 *
 * `CESIUM_CHECKS` lists the checks of the ports the Cesium renderer has.
 * Each migration adds the checks of the members it brings, so the suite
 * shows how far the renderer is through the contract; every other check is
 * left out of the run rather than failed. Each renderer's clock moves on
 * 1/60 s a frame, as the reference traces step, whatever the display's
 * rate. The pointer traces need a camera controller: without one, they are
 * checked in Node (`cameraGoldens.js` records them from Cesium's own).
 */
import { DEFAULT_TOLERANCE } from '../conformance/index.js';
import { toEcef } from '../stub/math.js';
import { createCesiumSceneRenderer, pointerFeedOf } from './sceneRenderer.js';

/** @type {ReadonlySet<string>} */
export const CESIUM_CHECKS = new Set([
  'camera.trace.setView angles',
  'camera.trace.setView keeps the position when only orientation is given',
  'camera.trace.lookAt sweep and release',
  'camera.trace.move, look, rotate and zoom',
  'camera.trace.commands inside a lookAt frame',
  'camera.trace.changed fires by each listener’s threshold',
  'camera.moveEnd',
  'camera.changed.order',
  'camera.controls.holds',
  'camera.controls.settings',
  'camera.follow',
  'camera.follow.autodetect',
  'camera.followFrame',
  'camera.trace.a cancelled flight stops where it was',
  'camera.flight.callbacks',
  'camera.onCommand',
  'camera.rect',
  'camera.trace.flyTo from orbit, default orientation and duration',
  'camera.trace.flyTo with duration and orientation',
  'camera.trace.flyTo with a height cap, pitch adjustment and named easings',
  'camera.trace.rectangle destinations',
  'camera.trace.flyToBounds default offset and explicit offset',
  'camera.trace.flyToBounds easing',
  'camera.trace.flyTo sineInOut',
  'camera.trace.view rectangles',
  'camera.trace.projection, picks and the horizon',
  'camera.followItem',
  'camera.trace.flyTo with a duration of 0 completes inside the call',
  'camera.trace.flyTo where the camera already is completes inside the call',
  'camera.setView.exact',
  'camera.viewRectangle',
  'camera.fov',
  'camera.trace.view and projection matrices',
  'credits',
  'credits.listenerRules',
  'draw.atlas',
  'draw.clampState',
  'draw.columns',
  'draw.columns.shown',
  'draw.drawOrder',
  'draw.drillPick',
  'draw.field.rasterShell',
  'draw.field.windStreamlines',
  'draw.icons.cluster',
  'draw.icons.distance',
  'draw.icons.images',
  'draw.icons.offsetTurn',
  'draw.icons.update',
  'draw.lines.depthFail',
  'draw.lines.settled',
  'draw.lines.styles',
  'draw.lines.outline',
  'draw.lines.drape',
  'draw.lines.split',
  'draw.lines.outlineDraped',
  'draw.lines.ageFade',
  'draw.lines.timeWindow',
  'draw.lines.breaks',
  'draw.lines.breaks.timeWindow',
  'draw.lines.segments',
  'draw.lines.segmentStyles',
  'draw.sets.blend',
  'draw.sets.recede',
  'draw.sets.recede.models',
  'draw.afterDispose',
  'draw.ids',
  'draw.models',
  'draw.shapes.lit',
  'draw.models.loadFailed',
  'draw.models.nodes',
  'draw.models.tint',
  'draw.models.blend',
  'draw.models.paint',
  'draw.models.update',
  'draw.models.parts',
  'draw.motion',
  'draw.motion.arc',
  'draw.motion.climb',
  'draw.motion.cluster',
  'draw.motion.live',
  'draw.motion.look',
  'draw.motion.shared',
  'draw.pick',
  'draw.points.update',
  'draw.points.population',
  'draw.displayRange',
  'draw.sets',
  'draw.shapes.clamped',
  'draw.shapes.overlay',
  'draw.shapes.drapedRotation',
  'draw.shapes.resize',
  'effects.crossfade',
  'effects.defineStyle',
  'effects.screenModulation',
  'effects.screenModulation.pixels',
  'effects.styles',
  'effects.withoutScreenModulation',
  'effects.withoutStyles',
  'frame.demand',
  'frame.order',
  'frame.prediction',
  'frame.renderOnce',
  'frame.suspend',
  'frame.time',
  'globe.imagery',
  'globe.imagery.canvas',
  'globe.imagery.decoded',
  'globe.imagery.frames',
  'globe.imagery.video',
  'globe.sky',
  'globe.split',
  'globe.surfaceShading',
  'globe.surfaceVersion',
  'globe.visible',
  'globe.withoutImageHooks',
  'input.behaviours',
  'input.clickPick',
  'input.lease',
  'input.lease.grab',
  'input.lease.lost',
  'input.lease.press',
  'query.heights',
  'query.pickBeforeStyles',
  'query.heights.sets',
  'query.projectMany',
  'query.rays',
  'query.withoutCapability',
  'query.occlusionTest',
  'quality',
  'quality.signals',
  'quality.signals.gpuTiming',
  'renderer.afterDestroy',
  'renderer.afterDestroy.frames',
  'renderer.listeners',
  'renderer.listenerRules',
  'renderer.shape',
  'renderer.capture',
  'renderer.readPixels',
  'renderer.releaseUnused',
  'renderer.whenSettled',
  'renderer.resize',
  'frame.onHeldChange',
  'frame.onHoldsChange',
  'frame.setTargetFps',
  'globe.setTerrain',
  'globe.setPhotoreal',
  'globe.progress',
  'effects.setStyleParams',
  'effects.bloom',
  'effects.sharpen',
  'quality.probe',
]);

/** A frame fails the check rather than hang it when frames stop. */
const FRAME_TIMEOUT_MS = 5000;

/**
 * One frame of the page: it resolves once the render loop's tick for the
 * next animation frame (drawn or not, or none while suspended) has run, so
 * loads and timers progress between frames. Cesium's loop asks for its
 * animation frame before this does, so its tick runs first. It asks for no
 * render itself: a check's own `requestRender` is what makes a tick draw.
 */
function nextFrame() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no animation frame came')),
      FRAME_TIMEOUT_MS,
    );
    requestAnimationFrame(() => {
      clearTimeout(timer);
      setTimeout(resolve, 0);
    });
  });
}

/**
 * @param {{name?: string, model?: string, missingModel?: string,
 *   cameraController?: Function}} [options]
 *   `model`: a glTF URL for the model checks; `missingModel`: one that
 *   fails to load, for the failure check; `cameraController`: the camera
 *   port on that controller (`controlledCamera.js`).
 * @returns {import('../conformance/index.js').ConformanceHarness}
 */
export function createCesiumHarness({
  name = 'cesium',
  model,
  modelNode,
  missingModel,
  cameraController,
} = {}) {
  // Each renderer's ticks, tweens and camera events read a clock of its
  // own that each frame moves on by 1/60 s: flights then step as the
  // reference traces do, frame by frame.
  const clocks = new WeakMap();
  const containers = new WeakMap();
  return {
    name,
    // A camera controller hears the pointer events sent through `pointer`
    // (the input port's), so the camera scripts' drags and wheels run.
    ...(cameraController ? { cameraInput: true } : {}),
    async create({ viewport, capabilities }) {
      const container = document.createElement('div');
      container.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px`;
      document.body.append(container);
      let renderer;
      const clock = { ms: performance.now() };
      try {
        renderer = await createCesiumSceneRenderer({
          container,
          capabilities,
          ...(cameraController ? { cameraController } : {}),
          now: () => clock.ms,
        });
      } catch (error) {
        container.remove();
        throw error;
      }
      const destroy = renderer.destroy;
      const { canvas } = renderer;
      renderer.destroy = () => {
        try {
          destroy();
        } finally {
          // Free the context now: a full run makes more widgets than the
          // browser keeps contexts for.
          (canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
            ?.getExtension('WEBGL_lose_context')
            ?.loseContext();
          container.remove();
        }
      };
      clocks.set(renderer, clock);
      containers.set(renderer, container);
      return renderer;
    },
    resizeContainer: (r, { width, height }) => {
      const container = containers.get(r);
      if (!container) return;
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
    },
    frame: (r) => {
      const clock = clocks.get(r);
      if (clock) clock.ms += 1000 / 60;
      return nextFrame();
    },
    // Events as the renderer's handler delivers them: the checks send ones
    // no real pointer can (a click with no press), so not DOM events.
    pointer: (r, type, x, y, extra) => pointerFeedOf(r)(type, x, y, extra),
    now: (r) => clocks.get(r)?.ms ?? performance.now(),
    // What a live motion clock reads.
    wallTime: () => Date.now(),
    toEcef,
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'trace',
    ...(model
      ? {
          assets: {
            model,
            ...(modelNode ? { modelNode } : {}),
            missingModel,
            // The model's bytes, for the check that a model drawn from them
            // never fetches its url.
            modelBytes: async () =>
              new Uint8Array(await (await fetch(model)).arrayBuffer()),
          },
        }
      : {}),
  };
}
