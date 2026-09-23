import { CATALOG_REFRESH_MS, WEB_RECEIVERS_LAYER_ID } from './policy.js';

export function createControls({ state: layerState, parts }) {
  const methods = {
    id: WEB_RECEIVERS_LAYER_ID,

    name: 'Web Receivers',

    icon: '⌁',

    source: 'Receiverbook / KiwiSDR',

    updateInterval: CATALOG_REFRESH_MS,

    /** Apply the manager-owned lifecycle gate to visible and pickable state. */
    setLifecyclePresentation({
      lifecycleState = null,
      enabled = false,
      uncertain = false,
    } = {}) {
      const settled = enabled ? 'enabled' : 'disabled';
      layerState._managerPresentation = {
        lifecycleState: [
          'enabling',
          'enabled',
          'disabling',
          'disabled',
        ].includes(lifecycleState)
          ? lifecycleState
          : settled,
        enabled: Boolean(enabled),
        uncertain: Boolean(uncertain),
      };
      parts.interaction.syncPresentation();
      parts.presentation.emitState();
    },

    getStats() {
      return {
        count: layerState._receivers.length,
        filtered: parts.queries.visibleReceivers().length,
        selected: layerState._selectedId,
        stale: layerState._stale,
        degraded: layerState._degraded,
        loading: layerState._loading,
        error: layerState._error,
        lastUpdate: layerState._updatedAt
          ? Date.parse(layerState._updatedAt)
          : null,
      };
    },

    subscribe: parts.presentation.subscribe,

    getUIState: parts.presentation.getUIState,

    getReceivers: () => layerState._receivers,

    getReceiver: parts.queries.getReceiver,

    ensureLoaded: parts.ingestion.ensureLoaded,

    setFilter: parts.queries.setFilter,

    selectReceiver: parts.queries.selectReceiver,

    resolveReceiver: parts.queries.resolveReceiver,

    find: parts.queries.find,

    highlight: parts.queries.highlight,

    frame: parts.rendering.frame,

    flyTo: parts.rendering.flyTo,

    tune: parts.queries.tune,

    showSpectrum: parts.queries.showSpectrum,
  };

  return { methods };
}
