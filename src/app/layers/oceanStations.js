import * as Cesium from 'cesium';
import { createOceanStationsLayer } from '../../layers/oceanStations/index.js';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire ocean stations observations to the application overlay host. */
export function createApplicationOceanStations(options) {
  return createOceanStationsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (target) => {
      const element = target?.scene?.canvas || target?.canvas || target;
      return new Cesium.ScreenSpaceEventHandler(element);
    },
    picking,
    pointer: { isPointerFree },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    ...options,
  });
}
