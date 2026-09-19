export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'rocket-launches',

    name: 'Space Missions (30d)',

    icon: 'rocket',

    source: 'Launch Library 2',

    updateInterval: 300000,

    /** Release only Space Mission camera ownership, preserving layer and selection state. */
    releaseCameraOwnership() {
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      parts.selection.stopMissionZoomAnchor();
    },

    getStats() {
      return {
        count: layerState._count,
        orbitMatches: layerState._orbitMatches,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
      };
    },

    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
    },
  };

  return { methods };
}
