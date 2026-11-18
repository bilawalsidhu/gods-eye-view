/**
 * @module maps/engine
 * @description What the map stacks switch through: the providers each
 * stack's imagery and terrain come from, and the scene operations the map
 * source controller (`controller.js`) switches stacks with.
 *
 * The renderer's plugin may hand the application a map engine of its own
 * (`mapEngine` in `src/render/applicationHooks.js`); when it hands none, the
 * renderer switches through its globe port (`globeEngine.js`). A viewer
 * with no renderer bound uses the engine its adapter
 * provided as it loaded (the Cesium one through the package's
 * `./render/cesium/unbound` export).
 */
import { applicationHooksOf } from '../render/applicationHooks.js';
import { rendererOf } from '../render/rendererOf.js';
import { globeMapEngine } from './globeEngine.js';

let provided = null;

/**
 * Provide the map engine for viewers no renderer is bound to; a later call
 * replaces it.
 * @param {object} engine
 */
export function provideMapEngine(engine) {
  provided = engine;
}

/**
 * The map engine the renderer adapter provided for viewers no renderer is
 * bound to.
 * @returns {object}
 * @throws {Error} When no adapter has provided one yet.
 */
export function mapEngine() {
  if (!provided)
    throw new Error(
      'No map engine: load the renderer, or the package export ./render/cesium/unbound, first',
    );
  return provided;
}

/**
 * The map engine the map stacks of `host` switch through: its renderer's
 * own, else its renderer's globe port, else (no renderer bound) the one the
 * adapter provided.
 * @param {object} host The scene object.
 * @returns {object}
 */
export function mapEngineFor(host) {
  const renderer = rendererOf(host);
  if (!renderer) return mapEngine();
  return applicationHooksOf(renderer).mapEngine ?? globeMapEngine;
}
