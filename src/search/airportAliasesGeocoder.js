/**
 * Offline aliases for famous airports that people search by short name.
 *
 * Exact match only — anything else falls through to the network geocoders.
 * These exist because Photon (and sometimes Nominatim) prefer a small
 * exact-name locality over a major aerodrome whose OSM name is longer.
 * Heathrow is the canonical example: the Florida locality wins over
 * London Heathrow Airport.
 */
const AIRPORT_ALIASES = Object.freeze({
  heathrow: {
    lat: 51.467739,
    lng: -0.4587801,
    name: 'London Heathrow Airport',
    // i18n-ignore: place name data, not UI copy
    label: 'London Heathrow Airport, United Kingdom',
    types: ['airport'],
  },
  // Additional high-traffic short names can be added here later.
});

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a small framing box around an airport so the camera does not land
 * at rooftop range.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [halfSpan=0.015]
 */
function airportViewport(lat, lng, halfSpan = 0.015) {
  return {
    southwest: { lat: lat - halfSpan, lng: lng - halfSpan },
    northeast: { lat: lat + halfSpan, lng: lng + halfSpan },
  };
}

export function createAirportAliasesGeocoder() {
  const byName = new Map();
  for (const [alias, place] of Object.entries(AIRPORT_ALIASES)) {
    byName.set(normalizeName(alias), {
      ...place,
      exact: true,
      viewport: airportViewport(place.lat, place.lng),
    });
  }

  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const place = byName.get(normalizeName(query));
      return place
        ? { place, answered: true }
        : { place: null, answered: true };
    },
  };
}
