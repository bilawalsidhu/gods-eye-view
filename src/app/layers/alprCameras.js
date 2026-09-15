import { createAlprCamerasLayer } from '../../layers/alpr/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { registerWorldOverlayPaintLane } from '../../overlays/worldOverlay.js';
import { keyholeLabelAlphaFromGeometry } from '../../celestialRing.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationAlpr({ surface, source }) {
  const { groundFloor } = surface;
  return createAlprCamerasLayer({
    source,
    services: {
      render,
      context,
      picking,
      groundFloor,
      overlays: {
        registerPaintLane: registerWorldOverlayPaintLane,
        keyholeAlpha: keyholeLabelAlphaFromGeometry,
        refreshReadout: refreshTrackedReadout,
        subscribeMapStack(callback) {
          window.addEventListener('gev:map-stack-changed', callback);
          return () =>
            window.removeEventListener('gev:map-stack-changed', callback);
        },
      },
    },
  });
}
