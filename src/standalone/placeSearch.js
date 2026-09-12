import {
  createPlaceSearch,
  createGoogleGeocoder,
  createPhotonGeocoder,
} from '../search/index.js';

/** Google first when configured, then Photon, then local Nominatim `/api/geocode`. */
export function createStandalonePlaceSearch({
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  signal,
} = {}) {
  return createPlaceSearch({
    signal,
    providers: [
      createGoogleGeocoder({
        request(query, { bias, signal }) {
          const key = resolveApiKey?.();
          if (!key) return null;
          const url = new URL(
            'https://maps.googleapis.com/maps/api/geocode/json',
          );
          url.searchParams.set('address', query);
          url.searchParams.set('key', key);
          if (bias) url.searchParams.set('bounds', bias);
          return fetchImpl(url.toString(), { signal });
        },
      }),
      createPhotonGeocoder({ fetchImpl }),
      createGoogleGeocoder({
        request(query, { bias, signal }) {
          const params = new URLSearchParams({ q: query });
          if (bias) params.set('bounds', bias);
          return fetchImpl(`/api/geocode?${params}`, { signal });
        },
      }),
    ],
  });
}
