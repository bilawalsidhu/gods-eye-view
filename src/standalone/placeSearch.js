import {
  createPlaceSearch,
  createCoordinateGeocoder,
  createPresetGeocoder,
  createGoogleGeocoder,
  createPhotonGeocoder,
} from '../search/index.js';
import { CITY_POIS } from '../locations.js';

/** Coordinates & bundled presets first, then Google when configured, then keyless Photon. */
export function createStandalonePlaceSearch({
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  signal,
} = {}) {
  return createPlaceSearch({
    signal,
    providers: [
      createCoordinateGeocoder(),
      createPresetGeocoder({ presets: CITY_POIS }),
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
    ],
  });
}
