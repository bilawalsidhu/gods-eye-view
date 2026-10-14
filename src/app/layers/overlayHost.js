import {
  clearOverlaySource,
  getWorldOverlayDiagnostics,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
export const overlayHost = Object.freeze({
  clearSource: clearOverlaySource,
  getDiagnostics: getWorldOverlayDiagnostics,
  hitTest: hitTestWorldOverlay,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
