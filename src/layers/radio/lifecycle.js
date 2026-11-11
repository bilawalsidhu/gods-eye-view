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
  rendererFactory,
}) {
  const { clearSource, setVisible } = services.overlays;

  const methods = {
    picks: {
      owner: 'radio',
      predicate: (id) => parts.renderer?.ownsPick(id) ?? false,
    },
    /** Initialize scene resources and the single audio element. */
    init(viewer, options = {}) {
      this.attachRenderer(options);
      layerState._sessionGeneration += 1;
      parts.clustering.resetRadioClusterOverlayIdentities();
      parts.playback.installAudio();
      clearSource(RADIO_OVERLAY_SOURCE_ID);
      setVisible(RADIO_OVERLAY_SOURCE_ID, false);
    },

    attachRenderer(options = {}) {
      if (parts.renderer?.ready)
        throw new Error('Radio layer is already initialized');
      if (typeof rendererFactory !== 'function')
        throw new TypeError('A radio renderer factory is required');
      parts.renderer = rendererFactory({
        state: layerState,
        services,
        parts,
        source,
        engine: options.engine,
      });
      if (!parts.renderer)
        throw new TypeError('Radio has no renderer on this engine');
      parts.renderer.init();
      if (layerState._enabled) {
        parts.rendering.drawStations(layerState._stations);
        parts.interaction.syncRadioLifecyclePresentation();
      }
    },

    resumeViewport() {
      if (parts.interaction.radioPresentationAllowed())
        parts.rendering.updateRenderVisibility();
    },

    detachRenderer() {
      parts.interaction.removeInteraction();
      clearTimeout(layerState._overlayPublishTimer);
      layerState._overlayPublishTimer = null;
      clearSource(RADIO_OVERLAY_SOURCE_ID);
      parts.renderer?.destroy();
      parts.renderer = null;
      layerState._renderById.clear();
      layerState._selectedPosition = null;
      layerState._lastHorizonCameraPosition = null;
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
      parts.renderer?.setVisible(false);
      parts.renderer?.clearSelected();
      layerState._selectedPosition = null;
      if (layerState._overlayPublishTimer)
        clearTimeout(layerState._overlayPublishTimer);
      layerState._overlayPublishTimer = null;
      parts.clustering.resetRadioClusterOverlayIdentities();
      layerState._overlayDiagnostics =
        parts.clustering.emptyRadioOverlayDiagnostics();
      clearSource(RADIO_OVERLAY_SOURCE_ID);
      setVisible(RADIO_OVERLAY_SOURCE_ID, false);
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
      clearSource(RADIO_OVERLAY_SOURCE_ID);
      parts.renderer?.destroy();
      parts.renderer = null;
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
      layerState._rejectedStationCount = 0;
      layerState._error = null;
      layerState._updatedAt = null;
      layerState._managerLifecyclePresentation = null;
      parts.presentation.emitState();
      layerState._listeners.clear();
      layerState._playbackControlListeners.clear();
    },
  };

  return { methods };
}
