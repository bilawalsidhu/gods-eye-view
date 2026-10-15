// The bridge for shell callers that still hold only a Cesium viewer (layers
// until phase 1c): the engine registered for that viewer. The app registers
// its scene engine (src/app/globeEngine.js) and unregisters it before
// destroying it. Nothing is ever built here, so no engine can outlive its
// viewer without a destroy path: an unregistered or torn-down viewer has none.

import { isGlobeEngine } from '../contract.js';

const engines = new WeakMap();

/**
 * Make `engine` the one returned for `viewer`.
 * @returns {() => void} Unregister (only while it is still the registered one).
 */
export function registerViewerEngine(viewer, engine) {
  engines.set(viewer, engine);
  return () => {
    if (engines.get(viewer) === engine) engines.delete(viewer);
  };
}

/**
 * @param {object | null | undefined} viewer A Cesium viewer, or an engine
 *   (returned as is).
 * @returns {import('../contract.js').GlobeEngine | null} The registered
 *   engine, or null.
 */
export function engineFromViewer(viewer) {
  if (viewer == null) return null;
  if (isGlobeEngine(viewer)) return viewer;
  return engines.get(viewer) ?? null;
}
