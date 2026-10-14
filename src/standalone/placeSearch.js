import { createDefaultPlaceSearch } from '../search/defaults.js';
import { getSharedPacer, shouldUseDirect } from '../mobile/sourcePolicy.js';
import {
  NOMINATIM_REVERSE_ENDPOINT,
  NOMINATIM_SEARCH_ENDPOINT,
} from '../mobile/adapters/geocodeDirect.js';

/**
 * Standalone place search. On-device without a backend, keyless geocoding
 * goes directly to Nominatim (paced through the shared geocode/route gate)
 * through the same `geocoding` seam the app already supports; an explicitly
 * configured `geocoding` provider always wins, and the web default is unchanged.
 * @param {object} options Passed to `createDefaultPlaceSearch`, plus
 *   `direct` (default: `shouldUseDirect()`) and `fetchImpl`.
 * @returns {*} Place search instance.
 */
export function createStandalonePlaceSearch(options = {}) {
  const { direct, fetchImpl, geocoding, ...rest } = options;
  const useDirect = direct ?? shouldUseDirect();
  // The web path delegates byte-identically (fetchImpl forwarding included).
  if (!useDirect) return createDefaultPlaceSearch(options);
  const transport = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const shared = getSharedPacer();
  const pacedFetch = async (url, init = {}) => {
    await shared.wait(init);
    return transport(url, init);
  };
  // The device-only `direct` flag never leaks downstream; the transport stays
  // paced through the shared gate on every on-device branch.
  if (geocoding)
    return createDefaultPlaceSearch({
      ...rest,
      fetchImpl: pacedFetch,
      geocoding,
    });
  return createDefaultPlaceSearch({
    ...rest,
    fetchImpl: pacedFetch,
    geocoding: {
      provider: 'nominatim',
      searchEndpoint: NOMINATIM_SEARCH_ENDPOINT,
      reverseEndpoint: NOMINATIM_REVERSE_ENDPOINT,
    },
  });
}
