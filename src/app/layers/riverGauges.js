import * as Cesium from 'cesium';
import { createRiverGaugesLayer } from '../../layers/riverGauges/index.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire NOAA NWPS river gauges into the application catalog. */
export function createApplicationRiverGauges({ source }) {
  return createRiverGaugesLayer({
    source,
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    pointer: { isPointerFree },
    render,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  });
}
