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
import { createWeatherDirectSource } from '../mobile/adapters/weatherDirect.js';
import { createRouteDirectSource } from '../mobile/adapters/geocodeDirect.js';
import {
  createCycloneDirectSource,
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
  const transport = fetchImpl ? { fetchImpl } : {};
  const mapillaryToken = import.meta.env?.MAPILLARY_CLIENT_TOKEN || '';
  const firmsKey =
    typeof getKey === 'function' ? () => getKey('FIRMS_MAP_KEY') : undefined;
  const mapTiles = createOpenFreeMapSource();
  const defaults = {
    ...createReferenceSources(),
    directions: useDirect
      ? createRouteDirectSource(transport)
      : createDirectionsSource(transport),
    'recent-imagery': createRecentImagerySource(),
    flights: createFlightSource(),
    military: createMilitarySource(),
    vessels: createVesselSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/vessels',
      // Resolved against the document's address, which a panel host may
      // serve from its own scheme.
      origin: () => globalThis.document?.baseURI ?? 'http://localhost',
    }),
    cctv: createCctvSource(),
    radio: useDirect
      ? createRadioDirectSource(transport)
      : createRadioSource(transport),
    traffic: createTrafficSource({ mapTiles }),
    transit: createTransitSource(),
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
    wind: createWindSource(),
    weather: useDirect
      ? createWeatherDirectSource(transport)
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
