// English catalog — layers namespace (phase-1 seed).
//
// Owns data-layer presentation copy: display names, feed-state labels, and
// layer batch toasts. Machine-readable values (layer ids, status enum keys,
// provider names) are intentionally NOT here — see ai_docs/i18n-ownership.md
// for the keep-English boundary. Keys are namespace-relative; the registry
// prefixes them with `layers.`.
export const NAMESPACE = 'layers';

export default {
  // src/data/manager.js FEED_STATE_LABELS value
  'status.unavailable': 'UNAVAILABLE',
  // src/data/flights.js / src/data/earthquakes.js layer display names
  'name.liveFlights': 'Live Flights',
  'name.earthquakes': 'Earthquakes (24h)',
  // src/ui.js clearSelectedLayers() result toasts (genuine plural copy)
  'clear.toast.noneSelected': 'No selected data layers',
  'clear.toast.cleared': {
    one: 'Cleared {count} data layer',
    other: 'Cleared {count} data layers',
  },
  'clear.toast.notCleared': {
    one: '{count} data layer could not be cleared',
    other: '{count} data layers could not be cleared',
  },
};
