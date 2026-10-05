import * as Cesium from 'cesium';
import { createCitsLayer } from '../../layers/cits/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** Wire the OpenTrafficMap C-ITS layer to application picking and overlays. */
export function createApplicationCits(options) {
  return createCitsLayer({
    // Resolved at call time: the overlay module can still be mid-evaluation
    // (import cycle) when the catalog constructs this layer.
    overlayHost: {
      setEntries: (...args) => overlays.setOverlayEntries(...args),
      setVisible: (...args) => overlays.setOverlaySourceVisible(...args),
      clearSource: (...args) => overlays.clearOverlaySource(...args),
      hitTest: (...args) => overlays.hitTestWorldOverlay(...args),
    },
    picking,
    pointer: { isPointerFree },
    render,
    overlayLanes: {
      register: (...args) => overlays.registerWorldOverlayPaintLane(...args),
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    ...options,
  });
}
