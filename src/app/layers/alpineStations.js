import { createAlpineStationsLayer } from '../../layers/alpineStations/index.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire the Alpine weather-station networks into the application catalog. */
export function createApplicationAlpineStations(options) {
  return createAlpineStationsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
    },
    ...options,
  });
}
