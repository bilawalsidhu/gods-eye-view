import { createAlpineStationsLayer } from '../../layers/alpineStations/index.js';
import * as overlays from '../../overlays/worldOverlay.js';
import {
  hideAlpineStationsCredit,
  showAlpineStationsCredit,
} from '../../data/dataCredits.js';

/** Wire the Alpine weather-station networks into the application catalog. */
export function createApplicationAlpineStations(options) {
  return createAlpineStationsLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
    },
    // CC BY requires the operators to be credited while their data is shown,
    // and SLF requires that reference to be clearly visible and linked.
    credit: { show: showAlpineStationsCredit, hide: hideAlpineStationsCredit },
    ...options,
  });
}
