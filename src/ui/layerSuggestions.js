// Suggested layers for Context: at most three, by simple
// rules, and only where a layer declares coverage. A suggestion never turns
// a layer on: it opens Data Layers with those rows picked out. No model, no
// requests: the rules read the layer list and the view alone.

/**
 * Where each layer has data, declared once. 'global' means everywhere. A
 * layer whose data comes from regional packs (cameras, transit) says nothing
 * until its packs publish their bounds, and a layer that says nothing is
 * never suggested.
 */
export const LAYER_COVERAGE = Object.freeze({
  satellites: 'global',
  flights: 'global',
  'ais-live-vessels': 'global',
  'street-level': 'global',
  'local-firms': 'global',
  earthquakes: 'global',
  wind: 'global',
});

/**
 * What to suggest by the view: the whole globe, or a local (zoomed-in) view.
 * Only layers that declare coverage are listed; cameras and transit join the
 * local list once they declare theirs.
 */
const BY_VIEW = Object.freeze({
  globe: ['satellites', 'flights', 'ais-live-vessels'],
  local: ['street-level'],
});

/** With a layer on, what goes with it. */
const COMPANIONS = Object.freeze({
  flights: ['ais-live-vessels', 'satellites'],
  'ais-live-vessels': ['flights'],
  satellites: ['flights'],
  'local-firms': ['wind'],
  earthquakes: ['local-firms'],
});

/** At most this many suggestions. */
export const MAX_SUGGESTIONS = 3;

/**
 * Whether a layer declares data at a point. Only 'global' is declared today.
 * @param {string} layerId
 * @returns {boolean}
 */
export function coversView(layerId) {
  return LAYER_COVERAGE[layerId] === 'global';
}

/**
 * Up to three layer ids to suggest.
 * @param {Array<{id: string, enabled?: boolean, showInTogglePanel?: boolean, stats?: {keyRequired?: boolean}}>} rows
 *   The data manager's layer rows.
 * @param {{globe?: boolean}} [view] Whether the view shows the whole globe.
 * @returns {string[]}
 */
export function suggestLayers(rows, { globe = false } = {}) {
  const byId = new Map((rows || []).map((row) => [row.id, row]));
  const on = (rows || []).filter((row) => row.enabled).map((row) => row.id);
  const candidates = [
    ...on.flatMap((id) => COMPANIONS[id] || []),
    ...BY_VIEW[globe ? 'globe' : 'local'],
  ];
  const picked = [];
  for (const id of candidates) {
    if (picked.length >= MAX_SUGGESTIONS) break;
    const row = byId.get(id);
    if (
      !row ||
      row.enabled ||
      picked.includes(id) ||
      row.showInTogglePanel === false ||
      // Self-hosted without this layer's key: it could not show anything.
      row.stats?.keyRequired === true ||
      !coversView(id)
    )
      continue;
    picked.push(id);
  }
  return picked;
}
