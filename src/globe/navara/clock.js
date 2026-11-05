// The engine clock on a Navara view: the app clock (src/time/clock.js), with
// one frame time latched per turn of the view's loop. The engine calls
// beginFrame from its handler of the view's preUpdate, which Navara emits
// first on every turn of its loop (drawn or not), before raising the
// contract's preUpdate; every listener of the frame then reads that time.
// The look (look.js) reads the same clock for the sun.

import { appClock as pageClock } from '../../time/clock.js';

/**
 * @param {{ appClock?: import('../../time/clock.js').AppClock }} [options]
 *   `appClock` defaults to the page's app clock.
 * @returns {{ clock: import('../contract.js').GlobeClock, beginFrame: () => void }}
 */
export function createNavaraClock({ appClock = pageClock } = {}) {
  return {
    clock: {
      now: () => appClock.now(),
      frameTime: () => appClock.frameTime(),
    },
    beginFrame() {
      appClock.beginFrame();
    },
  };
}
