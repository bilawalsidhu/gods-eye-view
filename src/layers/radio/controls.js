import { stepChips } from '../../data/layerSteps.js';
import { t } from '../../i18n/index.js';
import { RADIO_DIRECTORY_REFRESH_MS } from './policy.js';

export function createControls({ state: layerState, services, parts, source }) {
  let unsubscribeRowControls = null;
  // ‹ Prev · Next › on the Data Layers row step through the stations in
  // view, as the mini player's buttons do: silent unless a station is
  // already playing, which then follows the selection.
  function stepStation(direction) {
    const sounding = ['loading', 'buffering', 'playing'].includes(
      layerState._audioState,
    );
    parts.selection.cycleRadioStation(direction, {
      rotate: true,
      autoplay: sounding,
      origin: 'user',
    });
  }
  const methods = {
    id: 'radio',

    name: 'Radio',

    icon: '◉',

    source: 'Radio Browser',

    updateInterval: RADIO_DIRECTORY_REFRESH_MS,

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
      // With the local receiver chosen no stations are shown, so none count.
      const local = layerState._source === 'local';
      return {
        count: local ? 0 : layerState._stations.length,
        filtered: local ? 0 : parts.queries.visibleStations().length,
        selected: layerState._selectedId,
        playing: layerState._audioStationId,
        stale: !local && layerState._stale,
        degraded: !local && layerState._degraded,
        loading: !local && layerState._loading,
        error: local ? null : layerState._error,
        lastUpdate:
          !local && layerState._updatedAt
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

    getLoadedRadioStations: () => layerState._stations,

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

    playStation: parts.selection.playRadioStation,

    stepStationWhileOff: parts.selection.stepRadioStationWhileOff,

    togglePlayback: parts.playback.toggleRadioPlayback,

    play: parts.playback.playSelectedRadio,

    playForVoice: parts.playback.playPreparedRadioForVoice,

    pause: parts.playback.pauseRadioPlayback,

    stopPlayback: parts.playback.stopRadioPlayback,

    /**
     * Name the stations whose stream plays on when the layer turns off
     * (a pinned station): `(stationId) => boolean`, or null for none.
     */
    keepStreamWhenOff(predicate) {
      layerState._keepStreamWhenOff =
        typeof predicate === 'function' ? predicate : null;
    },

    setVolume: parts.volume.setRadioVolume,

    setVoiceDucked: parts.volume.setRadioVoiceDucking,

    getRowControls() {
      // What Radio plays: the internet stations, or a local receiver,
      // whose card (the RTL-SDR controls) then shows on the row.
      const local = layerState._source === 'local';
      const segmented = {
        id: 'radio-source',
        ariaLabel: t('Radio source'),
        options: [
          ['internet', t('Internet stations')],
          ['local', t('Local receiver')],
        ].map(([value, label]) => ({
          id: `radio-source-${value}`,
          label,
          // The full label, should a long language need an ellipsis.
          title: label,
          active: layerState._source === value,
          params: { source: value },
        })),
      };
      if (local) return { chips: [], segmented, panel: 'sdr-radio-card' };
      if (
        !parts.interaction.radioPresentationAllowed() ||
        parts.queries.visibleStations().length < 2
      )
        return { chips: [], segmented };
      const broadcasterNotice = t(
        'Stations play straight from their broadcasters, who see your IP address.',
      );
      return {
        segmented,
        chips: stepChips(
          'station',
          t('Previous station'),
          t('Next station'),
          stepStation,
          broadcasterNotice,
        ),
      };
    },

    setRowControlsListener(listener) {
      unsubscribeRowControls?.();
      unsubscribeRowControls = null;
      if (!listener) return;
      // Redrawn only when the stations or whether they are offered change,
      // not on every playback tick.
      let previous = '';
      unsubscribeRowControls = parts.presentation.subscribeToRadio(() => {
        const key = `${layerState._source}|${parts.interaction.radioPresentationAllowed()}|${parts.queries.visibleStations().length > 1}`;
        if (key === previous) return;
        previous = key;
        listener();
      });
    },
  };

  return { methods };
}
