import { createDefaultPlaceSearch } from '../search/defaults.js';
import {
  NOMINATIM_MIN_INTERVAL_MS,
  shouldUseDirect,
  withUpstreamPacer,
} from '../mobile/sourcePolicy.js';
import {
  NOMINATIM_REVERSE_ENDPOINT,
  NOMINATIM_SEARCH_ENDPOINT,
} from '../mobile/adapters/geocodeDirect.js';

/**
 * Standalone place search. On-device without a backend, keyless geocoding
 * goes directly to Nominatim (paced at 1.1 s client-side) through the same
 * `geocoding` seam the app already supports; an explicitly configured
 * `geocoding` provider always wins, and the web default is unchanged.
 * @param {object} options Passed to `createDefaultPlaceSearch`, plus
 *   `direct` (default: `shouldUseDirect()`) and `fetchImpl`.
 * @returns {*} Place search instance.
 */
export function createStandalonePlaceSearch(options = {}) {
  const { direct, fetchImpl, geocoding, ...rest } = options;
  const useDirect = direct ?? shouldUseDirect();
  if (!useDirect || geocoding) return createDefaultPlaceSearch(options);
  const transport = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  return createDefaultPlaceSearch({
    ...rest,
    fetchImpl: withUpstreamPacer(transport, NOMINATIM_MIN_INTERVAL_MS),
    geocoding: {
      provider: 'nominatim',
      searchEndpoint: NOMINATIM_SEARCH_ENDPOINT,
      reverseEndpoint: NOMINATIM_REVERSE_ENDPOINT,
    },
  });
}
