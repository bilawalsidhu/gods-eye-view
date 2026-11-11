/**
 * Readouts other owners show in the Intel HUD. The vessel layer presents the
 * selected vessel here and the HUD subscribes, so neither reaches into the
 * other's markup.
 */

/** @type {?{text: string}} The selected vessel's lines, or null for none. */
let selectedVessel = null;
const vesselListeners = new Set();

/**
 * Show the selected vessel's readout, or clear it.
 * @param {?{text: string}} readout Its lines joined by newlines, or null.
 */
export function presentSelectedVessel(readout) {
  selectedVessel = readout ? Object.freeze({ text: readout.text }) : null;
  for (const listener of vesselListeners) listener(selectedVessel);
}

/**
 * Follow the selected vessel's readout; the current one is replayed at once.
 * @param {(readout: ?{text: string}) => void} listener
 * @returns {() => void} Stop following.
 */
export function subscribeSelectedVessel(listener) {
  vesselListeners.add(listener);
  listener(selectedVessel);
  return () => vesselListeners.delete(listener);
}
