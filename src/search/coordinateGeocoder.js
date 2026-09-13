import { parseCoordinateQuery } from './coordinateParser.js';

/**
 * Creates an offline geocoder that immediately resolves valid coordinates.
 * Handles Decimal Degrees (e.g. "43.1731, -79.0384"), Directional coordinates,
 * DMS, and MGRS strings with zero network roundtrips.
 */
export function createCoordinateGeocoder() {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const coord = parseCoordinateQuery(query);
      if (!coord) return { place: null, answered: false };

      return {
        place: {
          lat: coord.lat,
          lng: coord.lng,
          label: coord.label,
          types: ['coordinate'],
          viewport: {
            south: coord.lat - 0.015,
            north: coord.lat + 0.015,
            west: coord.lng - 0.015,
            east: coord.lng + 0.015,
          },
        },
        answered: true,
      };
    },
  };
}
