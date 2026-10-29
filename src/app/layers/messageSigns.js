import * as Cesium from 'cesium';
import { createMessageSignsLayer } from '../../layers/messageSigns/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { governorRequestRender } from '../../renderGovernor.js';

/** Wire the MnDOT Highway message signs layer into the application catalog. */
export function createApplicationMessageSigns({ surface, source }) {
  return createMessageSignsLayer({
    source,
    surface,
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    requestRender: () => governorRequestRender('message-signs'),
  });
}
