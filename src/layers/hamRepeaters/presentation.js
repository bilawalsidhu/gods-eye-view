import {
  LIST_LIMIT,
  REPEATER_BAND_FILTERS,
  REPEATER_KIND_FILTERS,
  describeArea,
  trimList,
} from '../../sources/hamRepeaters.js';

export function createPresentation({ state: layerState, parts }) {
  /** Snapshot consumed by the panel and the voice tool. */
  function getUIState() {
    const visible = parts.queries.visibleRepeaters();
    return Object.freeze({
      enabled: layerState._enabled,
      loading: layerState._loading,
      error: layerState._error,
      stale: layerState._stale,
      partial: layerState._partial,
      errors: layerState._errors,
      sources: layerState._sources,
      updatedAt: layerState._updatedAt,
      presentationActive: parts.interaction.presentationAllowed(),
      count: layerState._repeaters.length,
      filteredCount: visible.length,
      selectedId: layerState._selectedId,
      selected: layerState._selectedId
        ? layerState._byId.get(layerState._selectedId) || null
        : null,
      filter: { ...layerState._filter },
      filters: { kinds: REPEATER_KIND_FILTERS, bands: REPEATER_BAND_FILTERS },
      items: Object.freeze(trimList(visible, LIST_LIMIT)),
      area: layerState._area,
      areaLabel: describeArea(layerState._area),
      gate: layerState._gate,
      lastLoad: layerState._lastLoad,
    });
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
    try {
      layerState._rowControlsListener?.();
    } catch {
      // Same rule for the layer-row refresh.
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
