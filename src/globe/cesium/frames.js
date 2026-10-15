// Frame events on a Cesium scene. Listeners receive the frame's scene time
// as Unix milliseconds.

import * as Cesium from 'cesium';
import { bridgeEvent } from './events.js';

const toMilliseconds = (scene, time) => [
  Cesium.JulianDate.toDate(time).getTime(),
];

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ frames: object, destroy: () => void }}
 */
export function createCesiumFrames(viewer) {
  const { scene } = viewer;
  const bridges = ['preUpdate', 'preRender', 'postRender'].map((name) => [
    name,
    bridgeEvent(scene[name], toMilliseconds),
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
