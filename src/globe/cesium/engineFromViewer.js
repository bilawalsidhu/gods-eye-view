// The bridge for shell callers that still hold only a Cesium viewer (layers
// until phase 1c, standalone entries, tests): the engine of that viewer. The
// app registers its scene engine (src/app/globeEngine.js); any other viewer
// gets one built on first use and cached. Building one changes nothing in
// the viewer, and it is never destroyed here: its subscriptions live only as
// long as their callers keep them.

import { isGlobeEngine } from '../contract.js';
import { createCesiumEngine } from './createCesiumEngine.js';

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
 * @param {Parameters<typeof createCesiumEngine>[1]} [options] Used only when
 *   an engine has to be built.
 * @returns {import('../contract.js').GlobeEngine | null}
 */
export function engineFromViewer(viewer, options) {
  if (viewer == null) return null;
  if (isGlobeEngine(viewer)) return viewer;
  let engine = engines.get(viewer);
  if (!engine) {
    engine = createCesiumEngine(viewer, options);
    engines.set(viewer, engine);
  }
  return engine;
}
