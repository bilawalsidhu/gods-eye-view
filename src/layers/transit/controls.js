/**
 * Manager wiring. Transit's data arrives from camera-driven proximity polls,
 * not only from the manager's own tick, so the layer keeps a handle it can use
 * to repaint its panel row the moment a snapshot lands.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state }) {
  const methods = {
    /**
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      state._dataManager = dataManager;
    },
  };
  return { methods };
}
