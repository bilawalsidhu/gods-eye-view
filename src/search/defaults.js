import { createGeospatialServices } from './geospatial.js';
import { createHttpGeospatialProvider } from './http.js';
import { createPlaceSearch } from './placeSearch.js';
import { createGoogleGeocoder } from './google.js';
import { createPhotonGeocoder } from '../keylessGeocoder.js';
import { createCoordinateGeocoder } from './coordinateGeocoder.js';
import { createPresetGeocoder } from './presetGeocoder.js';

/**
 * Coordinates and bundled names first — both answer offline and with no key —
 * then Google when configured, then keyless Photon. Transport stays local to
 * setup.
 *
 * `presets` is the caller's bundled place data. It is passed in rather than
 * imported so this package keeps reading no application state; with none
 * supplied there is simply no bundled-name provider.
 */
export function createDefaultPlaceSearch({
  resolveApiKey,
  fetchImpl = (...args) => fetch(...args),
  signal,
  endpoints = {},
  providers = {},
  presets = null,
} = {}) {
  const forward = createPlaceSearch({
    signal,
    providers: providers.geocode || [
      createCoordinateGeocoder(),
      ...(presets ? [createPresetGeocoder({ presets })] : []),
      createGoogleGeocoder({
        request(query, { bias, signal }) {
          const key = resolveApiKey?.();
          if (!key) return null;
          const url = new URL(
            endpoints.geocode ||
              'https://maps.googleapis.com/maps/api/geocode/json',
          );
          url.searchParams.set('address', query);
          url.searchParams.set('key', key);
          if (bias) url.searchParams.set('bounds', bias);
          return fetchImpl(url.toString(), { signal });
        },
      }),
      createPhotonGeocoder({ fetchImpl, endpoint: endpoints.photon }),
    ],
  });
  return {
    ...forward,
    ...createGeospatialServices({
      signal,
      providers: {
        ...createHttpGeospatialProvider({
          fetchImpl,
          resolveApiKey,
          endpoints,
        }),
        ...providers,
      },
    }),
  };
}

// Compatibility for direct module callers. Application composition supplies its own instance.
export const defaultGeospatial = createDefaultPlaceSearch({
  resolveApiKey: () => globalThis.window?.__GOOGLE_MAPS_API_KEY__,
});
