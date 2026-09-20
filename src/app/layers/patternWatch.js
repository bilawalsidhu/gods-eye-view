import { createPatternWatchLayer } from '../../layers/patterns/index.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';

const overlayHost = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/** Bind pattern detection to the same catalog aircraft instances rendering uses. */
export function createApplicationPatterns({ flights, military }) {
  return createPatternWatchLayer({
    services: { flights, military },
    overlayHost,
  });
}
