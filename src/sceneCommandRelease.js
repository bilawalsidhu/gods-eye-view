/**
 * Let a turned-off layer's memory go.
 *
 * A renderer may keep a turned-off layer's draw commands, and through them
 * its whole data source, reachable after the layer stops drawing: the
 * default renderer does (see `src/render/cesium/sceneCommandRelease.js`).
 * After a layer finishes turning off, this asks for one frame and, once it
 * is drawn, has the renderer trim what that frame no longer drew.
 */

/**
 * After every layer disable, render one frame and trim once it is drawn.
 * @param {{frame: import('./render/contract/frame').FramePort,
 *   dataManager: object, requestRender: (reason: string) => void,
 *   trim: () => void}} deps `trim` drops what the last drawn frame did not
 *   draw.
 * @returns {() => void} uninstall
 */
export function installLayerReleaseTrim({
  frame,
  dataManager,
  requestRender,
  trim,
}) {
  let removeOneShot = null;
  const unsubscribe = dataManager.subscribe((change) => {
    if (change?.type !== 'visibility' || change.enabled !== false) return;
    if (removeOneShot) return; // a trim is already waiting for its frame
    removeOneShot = frame.on('postRender', () => {
      removeOneShot();
      removeOneShot = null;
      trim();
    });
    requestRender('layer-release-trim');
  });
  return () => {
    unsubscribe();
    removeOneShot?.();
    removeOneShot = null;
  };
}
