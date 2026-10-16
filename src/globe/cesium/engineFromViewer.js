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
  // The viewer's Cesium camera names the same engine, so callers that hold
  // only viewer.camera (camera sensitivity claims) reach the engine camera.
  const keys = [viewer, viewer?.camera, viewer?.scene?.camera].filter(
    (key, index, all) => key != null && all.indexOf(key) === index,
  );
  for (const key of keys) engines.set(key, engine);
  return () => {
    for (const key of keys)
      if (engines.get(key) === engine) engines.delete(key);
  };
}

/**
 * @param {object | null | undefined} viewer A Cesium viewer or its camera,
 *   or an engine (returned as is).
 * @returns {import('../contract.js').GlobeEngine | null} The registered
 *   engine, or null.
 */
export function engineFromViewer(viewer) {
  if (viewer == null) return null;
  if (isGlobeEngine(viewer)) return viewer;
  return engines.get(viewer) ?? null;
}
