import {
  createEarthquakesLayer as createLayer,
  createUsgsEarthquakeSource,
} from '../layers/earthquakes/index.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
export * from '../layers/earthquakes/index.js';
/** Wire the standalone source and application overlay owner. */
export function createEarthquakesLayer({
  source = createUsgsEarthquakeSource(),
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  },
} = {}) {
  return createLayer({ source, overlayHost });
}
export default createEarthquakesLayer();
