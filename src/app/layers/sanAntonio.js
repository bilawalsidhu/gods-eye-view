import * as Cesium from 'cesium';
import { createSanAntonioLayer } from '../../layers/sanAntonio/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Bind City reference collections to this application's selection services. */
export function createApplicationSanAntonioLayer(options) {
  return createSanAntonioLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    ...options,
  });
}
