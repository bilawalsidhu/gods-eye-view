// The engine clock on a Cesium viewer: the app clock (src/time/clock.js),
// with one frame time latched per turn of CesiumWidget's loop. The latch
// listens to the viewer clock's tick, which the widget runs right before
// scene.render, so every preUpdate/preRender/postRender listener of the frame
// (including those the app added to the scene before the engine existed)
// reads the same frame time. The viewer clock itself is never changed: the
// app does not animate it (shouldAnimate stays false), and its time still
// drives Cesium's own lighting as before. The tick subscription appears on
// first use (a ticked listener or a frameTime read) and destroy removes it.

import { createEngineEvent } from '../contract.js';
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
  const ticked = createEngineEvent();
  let removeTick = null;
  let destroyed = false;
  const onTick = () => ticked.raiseValue(appClock.beginFrame());
  const attach = () => {
    if (!removeTick && !destroyed)
      removeTick = tickSource.addEventListener(onTick);
  };
  const add = ticked.addEventListener;
  ticked.addEventListener = (listener) => {
    const remove = add(listener);
    attach();
    return remove;
  };
  return {
    clock: {
      now: () => appClock.now(),
      frameTime() {
        attach();
        return appClock.frameTime();
      },
      ticked,
    },
    destroy() {
      destroyed = true;
      const remove = removeTick;
      removeTick = null;
      remove?.();
    },
  };
}
