import {
  clearOverlaySource,
  getOverlayPaintRect,
  getWorldOverlayDiagnostics,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../../overlays/worldOverlay.js';
export const overlayHost = Object.freeze({
  clearSource: clearOverlaySource,
  getDiagnostics: getWorldOverlayDiagnostics,
  hitTest: hitTestWorldOverlay,
  paintRect: getOverlayPaintRect,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
