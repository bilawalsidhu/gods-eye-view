import {
  BAND_FILTERS,
  RECEIVER_TYPES,
  RECEIVER_TYPE_LABELS,
  describeReceiverBands,
} from '../../sources/webReceivers.js';

export function createPresentation({ state: layerState, parts }) {
  /** Snapshot consumed by the panel and the voice tools. */
  function getUIState() {
    const selected = layerState._selectedId
      ? layerState._byId.get(layerState._selectedId) || null
      : null;
    const visible = parts.queries.visibleReceivers();
    return {
      enabled: layerState._enabled,
      loading: layerState._loading,
      error: layerState._error,
      stale: layerState._stale,
      degraded: layerState._degraded,
      updatedAt: layerState._updatedAt,
      sources: layerState._sources,
      presentationActive: parts.interaction.presentationAllowed(),
      receiverCount: layerState._receivers.length,
      filteredCount: visible.length,
      filter: { ...layerState._filter },
      filters: {
        types: [
          { id: 'all', label: 'All receivers' },
          ...RECEIVER_TYPES.map((type) => ({
            id: type,
            label: RECEIVER_TYPE_LABELS[type],
          })),
        ],
        bands: BAND_FILTERS.map((entry) => ({
          id: entry.id,
          label: entry.label,
        })),
      },
      selected,
      selectedBands: selected ? describeReceiverBands(selected) : '',
      highlightedIds: [...layerState._highlightIds],
      lastTune: layerState._lastTune,
      lastSearch: layerState._lastSearch,
    };
  }

  function emitState() {
    const snapshot = getUIState();
    for (const listener of layerState._listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken consumer must not break the layer.
      }
    }
  }

  /** Subscribe to layer state; the current state is delivered immediately. */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    layerState._listeners.add(listener);
    try {
      listener(getUIState());
    } catch {
      // Same rule as emitState.
    }
    return () => layerState._listeners.delete(listener);
  }

  return { getUIState, emitState, subscribe };
}
