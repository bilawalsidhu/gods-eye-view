import * as Cesium from 'cesium';
import {
  createDroneAirspaceLayer,
  createDroneAirspaceCesiumRenderer,
} from '../../layers/droneAirspace/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire FAA special-use airspace into the application catalog. */
export function createApplicationDroneAirspace(options) {
  return createDroneAirspaceLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    createRenderer: ({ viewer, engine, screenSpaceEventHandlerFactory }) =>
      engine
        ? rendererFor('drone-airspace', engine, {
            viewer,
            screenSpaceEventHandlerFactory,
          })
        : createDroneAirspaceCesiumRenderer({
            viewer,
            screenSpaceEventHandlerFactory,
          }),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
