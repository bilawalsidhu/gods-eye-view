import {
  createAqhiLayer as createLayer,
  createEcccAqhiSource,
} from '../layers/aqhi/index.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
export * from '../layers/aqhi/index.js';
/** Wire the standalone source and application overlay owner. */
export function createAqhiLayer({
  source = createEcccAqhiSource(),
  overlayHost = {
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
    clearSource: clearOverlaySource,
  },
} = {}) {
  return createLayer({ source, overlayHost });
}
export default createAqhiLayer();
