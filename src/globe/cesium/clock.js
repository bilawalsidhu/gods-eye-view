// The engine clock on a Cesium viewer: the app clock (src/time/clock.js),
// with one frame time latched per turn of CesiumWidget's loop. The latch
// listens to the viewer clock's tick, which the widget runs right before
// scene.render, so every preUpdate/preRender/postRender listener of the frame
// (including those the app added to the scene before the engine existed)
// reads the same frame time. The viewer clock itself is never changed: the
// app does not animate it (shouldAnimate stays false), and its time still
// drives Cesium's own lighting as before.
//
// The latch is attached when the engine is created (the app creates it with
// the scene), so it runs before any onTick listener added later; one added
// before the engine existed would read the previous frame's time. destroy
// removes it. A viewer without a clock (tests, a bare scene) latches on the
// scene's preUpdate instead, attached on first use so creating the engine
// adds no scene listener.

import { appClock as pageClock } from '../../time/clock.js';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ appClock?: import('../../time/clock.js').AppClock }} [options]
 *   `appClock` defaults to the page's app clock.
 * @returns {{ clock: import('../contract.js').GlobeClock, destroy: () => void }}
 */
export function createCesiumClock(viewer, { appClock = pageClock } = {}) {
  // A viewer-shaped object without a clock (tests, a bare scene): the
  // scene's preUpdate opens the frame instead.
  const tickSource = viewer.clock?.onTick ?? viewer.scene.preUpdate;
  let removeTick = null;
  let destroyed = false;
  const onTick = () => {
    appClock.beginFrame();
  };
  const attach = () => {
    if (!removeTick && !destroyed)
      removeTick = tickSource.addEventListener(onTick);
  };
  if (viewer.clock?.onTick) attach();
  return {
    clock: {
      now: () => appClock.now(),
      frameTime() {
        attach();
        return appClock.frameTime();
      },
    },
    destroy() {
      destroyed = true;
      const remove = removeTick;
      removeTick = null;
      remove?.();
    },
  };
}
