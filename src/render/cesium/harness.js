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
import { createCesiumSceneRenderer } from './sceneRenderer.js';

/** @type {ReadonlySet<string>} */
export const CESIUM_CHECKS = new Set([
  'draw.drillPick',
  'draw.ids',
  'draw.models',
  'draw.pick',
  'draw.sets',
  'frame.order',
  'frame.renderOnce',
  'frame.time',
  'globe.sky',
  'query.heights',
  'query.heights.sets',
  'query.projectMany',
  'query.rays',
  'query.withoutCapability',
  'renderer.whenSettled',
]);

/** A tick fails the check rather than hang it when the loop has stopped. */
const TICK_TIMEOUT_MS = 5000;

/**
 * One tick of the render loop, through the contract: it resolves once the
 * next tick (drawn or not) has run, so loads and timers progress between
 * ticks. It asks for no frame itself, so a check's own `requestRender` is
 * what makes a tick draw.
 */
function nextTick(r) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('the render loop did not tick'));
    }, TICK_TIMEOUT_MS);
    const off = r.frame.on('preUpdate', () => {
      off();
      clearTimeout(timer);
      // The rest of the tick (render, postRender) runs in the same task.
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
    frame: nextTick,
    now: () => performance.now(),
    toEcef,
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'endpoints',
    ...(model ? { assets: { model } } : {}),
  };
}
