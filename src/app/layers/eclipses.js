import * as Cesium from 'cesium';
import { createEclipsePathsLayer } from '../../layers/eclipses/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { worldClock } from '../../time/worldClock.js';
import { overlayHost } from './overlayHost.js';

/** Wire the eclipse paths layer to the page's world clock and overlay host. */
export function createApplicationEclipsePaths(options) {
  return createEclipsePathsLayer({
    clock: worldClock,
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    pointer: { isPointerFree },
    ...options,
  });
}
