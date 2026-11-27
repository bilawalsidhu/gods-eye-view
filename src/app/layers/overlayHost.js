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

/** The application's asset URL for a bundled path (the layers' default resolveAsset). */
export const appAssetUrl = (url) =>
  `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`;

/** Open an outbound link in a new, unlinked tab. */
export const openExternal = (url) =>
  window.open(url, '_blank', 'noopener,noreferrer');
