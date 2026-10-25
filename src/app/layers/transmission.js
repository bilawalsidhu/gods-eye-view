import * as Cesium from 'cesium';
import { createTransmissionLayer } from '../../layers/transmission/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { showOsmCredit, hideOsmCredit } from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';

/** Connect the pilot to the application's shared input, attribution, and card owners. */
export function createApplicationTransmission(options) {
  return createTransmissionLayer({
    overlayHost: { ...overlayHost, hitTest: hitTestWorldOverlay },
    picking,
    pointer: { isPointerFree },
    credits: { show: showOsmCredit, hide: hideOsmCredit },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
