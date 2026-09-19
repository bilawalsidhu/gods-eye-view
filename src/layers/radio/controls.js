export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'radio',

    name: 'Radio',

    icon: 'radio',

    source: 'Radio Browser',

    updateInterval: 45 * 60 * 1000,

    /** Apply the manager-owned lifecycle gate to visible and pickable Radio state. */
    setLifecyclePresentation({
      lifecycleState = null,
      enabled = false,
      uncertain = false,
    } = {}) {
      const settledState = enabled ? 'enabled' : 'disabled';
      const normalizedState = [
        'enabling',
        'enabled',
        'disabling',
        'disabled',
      ].includes(lifecycleState)
        ? lifecycleState
        : settledState;
      layerState._managerLifecyclePresentation = {
        lifecycleState: normalizedState,
        enabled: Boolean(enabled),
        uncertain: Boolean(uncertain),
      };
      parts.interaction.syncRadioLifecyclePresentation();
      parts.presentation.emitState();
    },

    /** Layer statistics for HUD/debug surfaces. */
    getStats() {
      return {
        count: layerState._stations.length,
        filtered: parts.queries.visibleStations().length,
        selected: layerState._selectedId,
        playing: layerState._audioStationId,
        stale: layerState._stale,
        degraded: layerState._degraded,
        loading: layerState._loading,
        error: layerState._error,
        lastUpdate: layerState._updatedAt
          ? Date.parse(layerState._updatedAt)
          : null,
        horizonScans: layerState._horizonScanCount,
        overlayEntries: layerState._overlayDiagnostics.entryCount,
      };
    },

    subscribe: parts.presentation.subscribeToRadio,

    subscribePlaybackControls:
      parts.presentation.subscribeToRadioPlaybackControls,

    getAcceptedCatalogSnapshot:
      parts.presentation.getRadioAcceptedCatalogSnapshot,

    getUIState: parts.presentation.getRadioUIState,

    getParams: parts.selection.getRadioParams,

    setParams: parts.selection.setRadioParams,

    getOverlayDiagnostics: () => ({
      ...layerState._overlayDiagnostics,
      singletonTexts: [...layerState._overlayDiagnostics.singletonTexts],
      singletonIds: [...layerState._overlayDiagnostics.singletonIds],
      clusterTexts: [...layerState._overlayDiagnostics.clusterTexts],
      clusterIds: [...layerState._overlayDiagnostics.clusterIds],
      clusterMemberships: layerState._overlayDiagnostics.clusterMemberships.map(
        (entry) => ({ ...entry }),
      ),
    }),

    getTunerStations: parts.tuning.getRadioTunerStations,

    beginTuning: parts.tuning.beginRadioTuning,

    setTuningStatic: parts.tuning.setRadioTuningStatic,

    previewTuningStation: parts.tuning.previewRadioTuningStation,

    commitTuningStation: parts.tuning.commitRadioTuningStation,

    cancelTuning: parts.tuning.cancelRadioTuning,

    endTuning: parts.tuning.endRadioTuning,

    setFilter: parts.selection.setRadioFilter,

    selectStation: parts.selection.selectRadioStation,

    selectRequestedStation: parts.selection.selectRequestedRadioStation,

    cycleStation: parts.selection.cycleRadioStation,

    togglePlayback: parts.playback.toggleRadioPlayback,

    play: parts.playback.playSelectedRadio,

    playForVoice: parts.playback.playPreparedRadioForVoice,

    pause: parts.playback.pauseRadioPlayback,

    stopPlayback: parts.playback.stopRadioPlayback,

    setVolume: parts.volume.setRadioVolume,

    setVoiceDucked: parts.volume.setRadioVoiceDucking,
  };

  return { methods };
}
