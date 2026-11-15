import * as Cesium from 'cesium';
import { createAbyssLayer } from '../../layers/abyss/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire ABYSS deep-sea layer to the application overlay host. */
export function createApplicationAbyss(options = {}) {
  return createAbyssLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
    ...options,
  });
}
