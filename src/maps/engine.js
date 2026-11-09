/**
 * @module maps/engine
 * @description What the map stacks need from the renderer that no contract
 * port gives yet: the providers each stack's imagery and terrain come from,
 * and the scene operations the map source controller (`controller.js`)
 * switches stacks with. Cesium-free: the renderer adapter provides it
 * as it loads (the Cesium one in `src/render/cesium/mapEngine.js`, loaded by
 * the application's renderer and by the package's `./render/cesium/unbound`
 * export), and the map code asks for it when it first needs it.
 */

let provided = null;

/**
 * Provide the map engine; a later call replaces it.
 * @param {object} engine
 */
export function provideMapEngine(engine) {
  provided = engine;
}

/**
 * The map engine the renderer adapter provided.
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
