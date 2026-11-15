import * as Cesium from 'cesium';
import { createWildlifeSightingsLayer } from '../../layers/wildlifeSightings/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as sprites from '../../data/spriteOrder.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as focus from '../../worldFocus.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Bind the wildlife layer to the application's scene and selection owners. */
export function createApplicationWildlifeSightings(options) {
  return createWildlifeSightingsLayer({
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
    sprites,
    render,
    context,
    focus,
    ...options,
  });
}
