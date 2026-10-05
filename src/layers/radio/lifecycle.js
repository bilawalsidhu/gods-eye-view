import * as Cesium from 'cesium';
import {
  RADIO_OVERLAY_SOURCE_ID,
  DEFAULT_RADIO_VOLUME,
  EMPTY_ACCEPTED_CATALOG_SNAPSHOT,
  DEFAULT_RADIO_FILTER,
} from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearOverlaySource, setOverlaySourceVisible } = services.overlays;

  const methods = {
    /** Initialize the Cesium data source and the single audio element. */
    init(viewer) {
      layerState._sessionGeneration += 1;
      layerState._viewer = viewer;
      parts.clustering.resetRadioClusterOverlayIdentities();
      parts.playback.installAudio();
      if (!layerState._dataSource) {
        layerState._dataSource = new Cesium.CustomDataSource('Radio stations');
        viewer.dataSources.add(layerState._dataSource);
        parts.rendering.installClusterStyling();
      }
      layerState._dataSource.show = false;
      clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
      setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
    },

    /** Show stations. Enabling or preset restoration never starts audio. */
    enable() {
      layerState._enabled = true;
      parts.interaction.syncRadioLifecyclePresentation();
      parts.presentation.emitState();
    },

    /** Hide the layer and stop playback without forgetting the selected station. */
    disable() {
      layerState._sessionGeneration += 1;
      layerState._enabled = false;
      parts.navigation.invalidateRadioCameraNavigation();
      layerState._requestGeneration += 1;
      layerState._abortController?.abort();
      layerState._abortController = null;
      layerState._loading = false;
      layerState._selectionGeneration += 1;
      if (layerState._selectionTimer) clearTimeout(layerState._selectionTimer);
      layerState._selectionTimer = null;
      parts.interaction.removeInteraction();
      parts.tuning.endRadioTuning();
      layerState._cancelledTuningPresentationStation = null;
      layerState._tuningUnavailableStationId = null;
      parts.playback.stopRadioPlayback({ origin: 'layer-disable' });
      if (layerState._dataSource) layerState._dataSource.show = false;
      if (layerState._selectedEntity && layerState._viewer)
        layerState._viewer.entities.remove(layerState._selectedEntity);
      layerState._selectedEntity = null;
      if (layerState._overlayPublishTimer)
        clearTimeout(layerState._overlayPublishTimer);
      layerState._overlayPublishTimer = null;
      parts.clustering.resetRadioClusterOverlayIdentities();
      layerState._overlayDiagnostics =
        parts.clustering.emptyRadioOverlayDiagnostics();
      clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
      setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
      parts.presentation.emitState();
    },

    /** Release rendering, event, request, and playback resources. */
    destroy() {
      this.disable();
      parts.volume.cancelRadioVolumeTransition();
      layerState._voiceDucked = false;
      layerState._voiceRestoring = false;
      parts.tuning.endRadioTuning();
      const closedTuningNoise = layerState._tuningNoiseContext?.close?.();
      if (closedTuningNoise?.catch) void closedTuningNoise.catch(() => {});
      layerState._tuningNoiseContext = null;
      if (layerState._audio) layerState._audio.volume = DEFAULT_RADIO_VOLUME;
      layerState._audio = null;
      layerState._userVolume = DEFAULT_RADIO_VOLUME;
      layerState._removeClusterListener?.();
      layerState._removeClusterListener = null;
      if (layerState._dataSource && layerState._viewer)
        layerState._viewer.dataSources.remove(layerState._dataSource, true);
      layerState._dataSource = null;
      clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
      layerState._stations = [];
      layerState._acceptedCatalogSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
      layerState._stationById.clear();
      layerState._categories = Object.freeze([]);
      layerState._filter = DEFAULT_RADIO_FILTER;
      layerState._renderById.clear();
      parts.clustering.resetRadioClusterOverlayIdentities();
      layerState._lastHorizonCameraPosition = null;
      layerState._horizonScanCount = 0;
      layerState._selectedId = null;
      layerState._tuningPreviewId = null;
      layerState._tuningStartStationId = null;
      layerState._tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
      layerState._tuningStationById = new Map();
      layerState._tuningUnavailableStationId = null;
      layerState._cancelledTuningPresentationStation = null;
      layerState._loading = false;
      layerState._stale = false;
      layerState._degraded = false;
      layerState._error = null;
      layerState._updatedAt = null;
      layerState._managerLifecyclePresentation = null;
      layerState._viewer = null;
      parts.presentation.emitState();
      layerState._listeners.clear();
      layerState._playbackControlListeners.clear();
    },
  };

  return { methods };
}
