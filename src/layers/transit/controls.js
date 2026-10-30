/**
 * Manager wiring. Transit's data arrives from camera-driven proximity polls,
 * not only from the manager's own tick, so the layer keeps a handle it can use
 * to repaint its panel row the moment a snapshot lands.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts }) {
  const methods = {
    /**
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      state._dataManager = dataManager;
    },

    /**
     * Apply the row's display-mode chips.
     *
     * The Transit row draws two things: the live GTFS-RT fleet and the
     * static SNCF station network. The chips switch between them, and the
     * layer draws what the chip says.
     *
     * @param {{display?: string}} params Layer parameters.
     * @returns {boolean} True when the parameters were accepted.
     */
    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      const display = String(params.display ?? '').trim();
      if (!display) return false;
      if (!['both', 'vehicles', 'stations'].includes(display)) return false;
      parts.stations.applyDisplayMode(display);
      return true;
    },
  };
  return { methods };
}
