import * as Cesium from 'cesium';
import { createChesterCountyEmsLayer } from '../../layers/chesterCountyEms/index.js';
import { overlayHost } from './overlayHost.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire county icon picking and source links to the application's shared host. */
export function createApplicationChesterCountyEms(options) {
  return createChesterCountyEmsLayer({
    ...options,
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
  });
}
