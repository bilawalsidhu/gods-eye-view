// Frame events on a Cesium scene. Listeners receive the frame's scene time
// as Unix milliseconds.

import * as Cesium from 'cesium';
import { bridgeEvent } from './events.js';

let scratchGregorian;

// JulianDate.toDate(time).getTime() without the Date: frame events must not
// allocate. A raise without a time (not Cesium's own) reads the clock.
function unixMilliseconds(scene, time) {
  if (!time) return Date.now();
  const date = Cesium.JulianDate.toGregorianDate(time, scratchGregorian);
  return Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    date.hour,
    date.minute,
    date.isLeapSecond ? date.second - 1 : date.second,
    date.millisecond,
  );
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ frames: object, destroy: () => void }}
 */
export function createCesiumFrames(viewer) {
  scratchGregorian ??= new Cesium.GregorianDate();
  const { scene } = viewer;
  const bridges = ['preUpdate', 'preRender', 'postRender'].map((name) => [
    name,
    bridgeEvent(scene[name], { unary: unixMilliseconds }),
  ]);
  return {
    frames: Object.fromEntries(
      bridges.map(([name, bridge]) => [name, bridge.event]),
    ),
    destroy() {
      for (const [, bridge] of bridges) bridge.detach();
    },
  };
}
