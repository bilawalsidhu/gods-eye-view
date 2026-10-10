/**
 * Analyst answer-card wording: scope labels, truncation caveats, layer-state
 * refusals and region lookups. The model-facing query-spec error templates in
 * analystEngine.js stay English by design. English values are verbatim.
 */
export default {
  scope: {
    anywhere: 'anywhere in the loaded data',
    inView: 'in view',
    overRegion: 'over {name}',
    withinKmOf: 'within {km} km of {center}',
    withinKm: 'within {km} km',
    viewDetail: 'within {km} km of the view centre',
  },
  caveat: {
    countedFirst: 'counted the first {n} loaded records',
    countedOf: 'counted {n} of {m} loaded records',
    layerNote: '{layer}: {note}',
    layerStatus: '{layer} {status}',
  },
  refusal: {
    off: {
      one: '{names} is off. Offer to turn it on.',
      other: '{names} are off. Offer to turn it on.',
    },
    notReady: {
      one: '{names} is still loading or off — no records yet.',
      other: '{names} are still loading or off — no records yet.',
    },
    unavailable: {
      one: '{names} is unavailable or off right now.',
      other: '{names} are unavailable or off right now.',
    },
  },
  region: {
    timeout:
      'Looking up the boundary for "{name}" is taking too long — ask again in a moment.',
    unresolved:
      'I couldn\'t resolve a boundary for "{name}" — try a state, country, or a named natural region.',
  },
};
