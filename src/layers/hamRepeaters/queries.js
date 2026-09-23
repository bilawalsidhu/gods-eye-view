import {
  nearestRepeaters,
  normalizeRepeaterFilter,
  repeaterMatchesFilter,
  resolveRepeaterQuery,
} from '../../sources/hamRepeaters.js';

export function createQueries({ state: layerState, parts }) {
  function visibleRepeaters() {
    return layerState._repeaters.filter((row) =>
      repeaterMatchesFilter(row, layerState._filter),
    );
  }

  function getRepeater(id) {
    return id ? layerState._byId.get(String(id)) || null : null;
  }

  function resolve(query) {
    return resolveRepeaterQuery(query, layerState._repeaters);
  }

  /** Select by id, callsign, "DB0RTV B" or city; null clears the selection. */
  function select(query, { flyTo = false } = {}) {
    const repeater = query ? resolve(query) : null;
    if (!repeater) {
      layerState._selectedId = null;
      parts.rendering.restyleMarkers();
      parts.rendering.syncSelectionContext();
      parts.presentation.emitState();
      return null;
    }
    layerState._selectedId = repeater.id;
    if (layerState._hoverId === repeater.id) parts.rendering.setHover(null);
    parts.rendering.restyleMarkers();
    parts.rendering.syncSelectionContext();
    if (flyTo) parts.rendering.flyTo(repeater);
    parts.presentation.emitState();
    return repeater;
  }

  function setFilter(next = {}) {
    layerState._filter = normalizeRepeaterFilter(next, layerState._filter);
    parts.rendering.restyleMarkers();
    parts.presentation.emitState();
  }

  function nearest(lat, lon, n = 5) {
    return nearestRepeaters(
      layerState._repeaters,
      lat,
      lon,
      n,
      layerState._filter,
    );
  }

  return { visibleRepeaters, getRepeater, resolve, select, setFilter, nearest };
}
