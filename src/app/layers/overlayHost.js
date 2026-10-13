import {
  clearOverlaySource,
  getWorldOverlayDiagnostics,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
export const overlayHost = Object.freeze({
  clearSource: clearOverlaySource,
  getDiagnostics: getWorldOverlayDiagnostics,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
