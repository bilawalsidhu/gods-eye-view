import * as Cesium from 'cesium';
import { createBorderWaitsLayer } from '../../layers/borderWaits/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire CBP border wait times into the application catalog. */
export function createApplicationBorderWaits(options) {
  return createBorderWaitsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
