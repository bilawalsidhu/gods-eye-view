/** With no local coverage information, only the globe has default suggestions. */
const GLOBE_DEFAULTS = ['satellites', 'flights', 'ais-live-vessels'];

/** With a layer on, what goes with it. */
const COMPANIONS = Object.freeze({
  flights: ['ais-live-vessels', 'satellites'],
  'ais-live-vessels': ['flights'],
  satellites: ['flights'],
  'local-firms': ['wind'],
  earthquakes: ['local-firms'],
});

export const MAX_SUGGESTIONS = 3;

/**
 * Up to `MAX_SUGGESTIONS` layer ids to suggest.
 * @param {object[]} rows The data manager's layer rows.
 * @param {{globe?: boolean}} [view] Whether the view shows the whole globe.
 * @returns {string[]}
 */
export function suggestLayers(rows, { globe = false } = {}) {
  const byId = new Map((rows || []).map((row) => [row.id, row]));
  const on = (rows || []).filter((row) => row.enabled).map((row) => row.id);
  const candidates = [
    ...on.flatMap((id) => COMPANIONS[id] || []),
    ...(globe ? GLOBE_DEFAULTS : []),
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
      row.stats?.keyRequired === true ||
      row.stats?.sourceUnavailable === true ||
      // AIS and FIRMS use server-side keys. Before a successful update the
      // browser cannot distinguish a keyless host from an unused feed.
      ((id === 'ais-live-vessels' || id === 'local-firms') &&
        !row.stats?.lastUpdate)
    )
      continue;
    picked.push(id);
  }
  return picked;
}
