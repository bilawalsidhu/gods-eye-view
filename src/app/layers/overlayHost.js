import { worldOverlayFor } from '../../overlays/worldOverlay.js';
import {
  clearOverlaySource,
  getWorldOverlayDiagnostics,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
export const overlayHost = Object.freeze({
  forEngine: worldOverlayFor,
  clearSource: clearOverlaySource,
  getDiagnostics: getWorldOverlayDiagnostics,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
