import { createDirectionsSource } from '../layers/directions/source.js';
import { createRecentImagerySource } from '../layers/recentImagery/source.js';
import { createOpenFreeMapSource } from '../sources/openFreeMap.js';
import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createAlprTileSource } from '../layers/alpr/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWindSource } from '../layers/wind/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createMapillarySource } from '../layers/streetLevel/providers/mapillary/source.js';
import { createReferenceSources } from '../sources/reference.js';
import { shouldUseDirect } from '../mobile/sourcePolicy.js';
import { createDeviceFetch } from '../mobile/deviceFetch.js';
import { createRouteDirectSource } from '../mobile/adapters/geocodeDirect.js';
import {
  createCctvDirectLayerSource,
  createFlightsDirectLayerSource,
  createTransitDirectLayerSource,
  createVesselDirectLayerSource,
  createWeatherDirectLayerSource,
  createWindDirectLayerSource,
} from '../mobile/adapters/heavyLayerSources.js';
import { createTomtomFetchShim } from '../mobile/adapters/meteredDirect.js';
import { createDailyBudget } from '../mobile/governors.js';
import {
  createCycloneDirectSource,
  createFirePerimeterDirectSource,
  createFirmsDirectSource,
  createGbfsDirectSource,
  createRadioDirectSource,
} from '../mobile/adapters/staticFeedsDirect.js';
import { createMapillaryDirectSource } from '../mobile/adapters/tileFeedsDirect.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources(overrides = {}, options = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new TypeError('Source overrides must be an object');
  const { fetchImpl, getKey, direct } = options ?? {};
  // On-device without a backend, keyless sources fetch upstreams directly;
  // everywhere else the legacy same-origin proxies are built untouched.
  const useDirect = direct ?? shouldUseDirect();
  // Without an explicit transport, on-device sources share the native
  // registry-enforced device fetch; web/backend callers are unaffected.
  const deviceFetch =
    fetchImpl ?? (useDirect ? createDeviceFetch() : undefined);
  const transport = deviceFetch ? { fetchImpl: deviceFetch } : {};
  const mapillaryToken = import.meta.env?.MAPILLARY_CLIENT_TOKEN || '';
  const firmsKey =
    typeof getKey === 'function' ? () => getKey('FIRMS_MAP_KEY') : undefined;
  const openskyId =
    typeof getKey === 'function' ? () => getKey('OPENSKY_CLIENT_ID') : null;
  const openskySecret =
    typeof getKey === 'function' ? () => getKey('OPENSKY_CLIENT_SECRET') : null;
  const aisKey =
    typeof getKey === 'function' ? () => getKey('AISSTREAM_API_KEY') : null;
  const tomtomKey =
    typeof getKey === 'function' ? () => getKey('TOMTOM_API_KEY') : null;
  // TomTom daily tile budget persists in memory per page; the vault key is
  // the operator's own, so a reload resetting the count is acceptable.
  const tomtomBudget = useDirect ? createDailyBudget({ limit: 6000 }) : null;
  const tomtomFetch =
    useDirect && deviceFetch
      ? createTomtomFetchShim({
          fetchImpl: deviceFetch,
          getKey: tomtomKey,
          budget: tomtomBudget,
        })
      : undefined;
  const mapTiles = createOpenFreeMapSource();
  const defaults = {
    ...createReferenceSources(),
    ...(useDirect
      ? { 'fire-perimeters': createFirePerimeterDirectSource(transport) }
      : {}),
    directions: useDirect
      ? createRouteDirectSource(transport)
      : createDirectionsSource(transport),
    'recent-imagery': createRecentImagerySource(),
    flights: useDirect
      ? createFlightsDirectLayerSource({
          ...transport,
          getClientId: openskyId,
          getClientSecret: openskySecret,
        })
      : createFlightSource(),
    military: createMilitarySource(),
    vessels: useDirect
      ? createVesselDirectLayerSource({ getKey: aisKey })
      : createVesselSource({
          apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/vessels',
          // Resolved against the document's address, which a panel host may
          // serve from its own scheme.
          origin: () => globalThis.document?.baseURI ?? 'http://localhost',
        }),
    cctv: useDirect
      ? createCctvDirectLayerSource(transport)
      : createCctvSource(),
    radio: useDirect
      ? createRadioDirectSource(transport)
      : createRadioSource(transport),
    traffic:
      useDirect && tomtomFetch
        ? createTrafficSource({ fetchImpl: tomtomFetch, mapTiles })
        : createTrafficSource({ mapTiles }),
    transit: useDirect
      ? createTransitDirectLayerSource(transport)
      : createTransitSource(),
    bikeshare: useDirect
      ? createGbfsDirectSource(transport)
      : createBikeshareSource(transport),
    installations: createInstallationSource({ mapTiles }),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createAlprTileSource(),
    firms: useDirect
      ? createFirmsDirectSource({ ...transport, getKey: firmsKey })
      : createFirmsSource(transport),
    wind: useDirect
      ? createWindDirectLayerSource(transport)
      : createWindSource(),
    weather: useDirect
      ? createWeatherDirectLayerSource(transport)
      : createWeatherSource(transport),
    cyclones: useDirect
      ? createCycloneDirectSource(transport)
      : createCycloneSource(transport),
    mapillary: useDirect
      ? createMapillaryDirectSource({ ...transport, token: mapillaryToken })
      : createMapillarySource({
          token: mapillaryToken,
        }),
  };
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, name))
      throw new TypeError(`Unknown source: ${name}`);
  }
  return { ...defaults, ...overrides };
}
