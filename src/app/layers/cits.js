import * as Cesium from 'cesium';
import { createCitsLayer } from '../../layers/cits/index.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';
import * as render from '../../renderGovernor.js';
import { registerWorldOverlayPaintLane } from '../../overlays/worldOverlay.js';

/** Wire the OpenTrafficMap C-ITS layer to application picking. */
export function createApplicationCits(options) {
  return createCitsLayer({
    overlayHost,
    picking,
    render,
    // Resolved at call time: the overlay module can still be mid-evaluation
    // (import cycle) when the catalog constructs this layer.
    overlayLanes: {
      register: (...args) => registerWorldOverlayPaintLane(...args),
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
