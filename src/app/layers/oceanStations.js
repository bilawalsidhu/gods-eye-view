import * as Cesium from 'cesium';
import { createOceanStationsLayer } from '../../layers/oceanStations/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire ocean stations observations to the application overlay host. */
export function createApplicationOceanStations(options) {
  return createOceanStationsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
    ...options,
  });
}
