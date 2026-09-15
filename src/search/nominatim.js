import {
  createNominatimClient,
  normalizeNominatimResult,
  normalizeNominatimReverse,
} from '../sources/nominatim.js';
import { normalizeGooglePlace } from './google.js';
export {
  createNominatimClient,
  normalizeNominatimResult,
  normalizeNominatimReverse,
};

/** Forward and reverse operations only; feature queries and routing are separate. */
export function createNominatimProvider(options = {}) {
  const client = createNominatimClient(options);
  return {
    attribution: {
      geocode: 'OpenStreetMap / Nominatim',
      reverseGeocode: 'OpenStreetMap / Nominatim',
    },
    ...(client.search
      ? {
          async geocode(query, options = {}) {
            try {
              const rows = await client.search(query, options);
              return {
                place: rows.length
                  ? normalizeGooglePlace(normalizeNominatimResult(rows[0]))
                  : null,
                answered: true,
              };
            } catch {
              options.signal?.throwIfAborted();
              return { place: null, answered: false };
            }
          },
        }
      : {}),
    ...(client.reverse
      ? {
          async reverseGeocode(latitude, longitude, options) {
            const row = await client.reverse(latitude, longitude, options);
            return row ? normalizeNominatimReverse(row) : null;
          },
        }
      : {}),
  };
}
