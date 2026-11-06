/**
 * A frame port over a fake Cesium scene, for tests of code that steers the
 * render loop through `renderGovernor.js`. It writes the scene the way the
 * Cesium port does (`src/render/cesium/ports.js`): holds, counted per
 * reason, keep `requestRenderMode` false; releasing the last asks for one
 * frame; a request is the scene's `requestRender`. Only the members the
 * governor uses. One port per scene, so a test can uninstall what it
 * installed.
 * @param {{requestRenderMode?: boolean, requestRender?: () => void}} scene
 */
export function framePortFor(scene) {
  let port = ports.get(scene);
  if (!port) ports.set(scene, (port = makePort(scene)));
  return port;
}

const ports = new WeakMap();

function makePort(scene) {
  const holds = new Map();
  const apply = () => {
    scene.requestRenderMode = holds.size === 0;
  };
  apply();
  return {
    requestRender() {
      scene.requestRender?.();
    },
    holdContinuous(reason) {
      holds.set(reason, (holds.get(reason) ?? 0) + 1);
      apply();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = holds.get(reason) - 1;
        if (left > 0) holds.set(reason, left);
        else holds.delete(reason);
        apply();
        if (holds.size === 0) scene.requestRender?.();
      };
    },
  };
}
