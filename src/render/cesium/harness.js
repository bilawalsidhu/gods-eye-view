/**
 * @module render/cesium/harness
 * @description The Cesium renderer as the conformance suite's renderer under
 * test, in the `/dev/conformance/` page.
 *
 * `CESIUM_CHECKS` lists the checks of the ports the Cesium renderer has.
 * Each migration adds the checks of the members it brings, so the suite
 * shows how far the renderer is through the contract; every other check is
 * left out of the run rather than failed.
 */
import { DEFAULT_TOLERANCE } from '../conformance/index.js';
import { toEcef } from '../stub/math.js';
import { createCesiumSceneRenderer, pointerFeedOf } from './sceneRenderer.js';

/** @type {ReadonlySet<string>} */
export const CESIUM_CHECKS = new Set([
  'camera.viewRectangle',
  'draw.drillPick',
  'draw.ids',
  'draw.models',
  'draw.pick',
  'draw.sets',
  'frame.demand',
  'frame.order',
  'frame.prediction',
  'frame.renderOnce',
  'frame.suspend',
  'frame.time',
  'globe.sky',
  'input.behaviours',
  'input.clickPick',
  'input.lease',
  'input.lease.grab',
  'input.lease.press',
  'query.heights',
  'query.heights.sets',
  'query.projectMany',
  'query.rays',
  'query.withoutCapability',
  'renderer.listeners',
  'renderer.whenSettled',
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
 * @param {{name?: string, model?: string}} [options] `model`: a glTF URL
 *   for the model checks.
 * @returns {import('../conformance/index.js').ConformanceHarness}
 */
export function createCesiumHarness({ name = 'cesium', model } = {}) {
  return {
    name,
    async create({ viewport, capabilities }) {
      const container = document.createElement('div');
      container.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px`;
      document.body.append(container);
      let renderer;
      try {
        renderer = await createCesiumSceneRenderer({ container, capabilities });
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
      return renderer;
    },
    frame: nextFrame,
    // Events as the renderer's handler delivers them: the checks send ones
    // no real pointer can (a click with no press), so not DOM events.
    pointer: (r, type, x, y, extra) => pointerFeedOf(r)(type, x, y, extra),
    now: () => performance.now(),
    toEcef,
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'endpoints',
    ...(model ? { assets: { model } } : {}),
  };
}
