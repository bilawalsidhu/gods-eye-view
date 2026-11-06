import { createCesiumEngine } from '../globe/cesium/createCesiumEngine.js';
import { registerViewerEngine } from '../globe/cesium/engineFromViewer.js';

/**
 * Build the page's one globe engine on the application viewer and tie its
 * teardown to the scene lifetime; it stays registered for the viewer
 * (engineFromViewer) while it lives. Call after the viewer's own cleanup is
 * deferred, so the engine is destroyed first. Render holds taken before the
 * render governor is installed apply when it is (src/renderGovernor.js).
 * @param {Cesium.Viewer} viewer
 * @param {{
 *   tilesetRef: { current: object | null } | (() => object | null) | null,
 *   defer: (dispose: () => void) => void,
 *   createEngine?: typeof createCesiumEngine,
 * }} options
 * @returns {import('../globe/contract.js').GlobeEngine}
 */
export function createSceneEngine(
  viewer,
  { tilesetRef, defer, createEngine = createCesiumEngine },
) {
  const engine = createEngine(viewer, { tilesetRef });
  const unregister = registerViewerEngine(viewer, engine);
  defer(() => {
    unregister();
    engine.destroy();
  });
  return engine;
}
