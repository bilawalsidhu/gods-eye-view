/**
 * The default services Core's tools read: the layers' portable source
 * factories and the application request services. `fetchImpl` must resolve
 * the sources' relative `/api/...` paths; in a browser the page's own fetch
 * does, and elsewhere a caller supplies a resolving fetch. `appUrl` is the
 * address the app is served from; `app.fetch` requests the app's own paths.
 */

import { createAlprTileSource } from '../layers/alpr/source.js';
import { GBFS_CITY_REGISTRY } from '../layers/bikeshare/registry.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { searchHls } from '../layers/recentImagery/catalog.js';
import { rankLatest, wvsSnapshotUrl } from '../layers/recentImagery/model.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createWindSource } from '../layers/wind/source.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { createEventPackSource } from '../sources/eventPacks.js';
import { createInfrastructureSource } from '../sources/infrastructureData.js';
import {
  createAdsbLolSource,
  createAisStreamSource,
  createOpenSkySource,
} from '../sources/live/standalone.js';
import {
  createGeocodePlaceService,
  createPlaceSearchService,
  createRouteService,
} from './places.js';

/** Construct every service Core's tools read. */
export function createToolServices({ fetchImpl, appUrl }) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('A fetch implementation is required');
  const requests = createApplicationRequestServices({ fetchImpl });
  return {
    app: { baseUrl: appUrl, fetch: fetchImpl },
    earthquakes: createUsgsEarthquakeSource({ fetchImpl }),
    fires: createFirmsSource({ fetchImpl }),
    launches: createLaunchSource({ fetchImpl }),
    aircraft: createOpenSkySource({ fetchImpl }),
    military: createAdsbLolSource({ fetchImpl }),
    vessels: createAisStreamSource({
      fetchImpl,
      origin: () => new URL(appUrl).origin,
    }),
    satellites: createSatelliteSource({ fetchImpl }),
    cctv: createCctvSource({ fetchImpl }),
    radio: createRadioSource({ fetchImpl }),
    placeSearch: createPlaceSearchService({ fetchImpl }),
    routing: createRouteService({ fetchImpl }),
    bikeshare: {
      systems: GBFS_CITY_REGISTRY,
      getStations: createBikeshareSource({ fetchImpl }).getStations,
    },
    transit: createTransitSource({ fetchImpl }),
    traffic: createTrafficSource({ fetchImpl, tileFetchImpl: fetchImpl }),
    weather: requests.weather,
    weatherMaps: createWeatherSource({ fetchImpl }),
    wind: createWindSource({ fetchImpl }),
    imagery: createImageryService({ fetchImpl }),
    cables: createBundledCableSource({ fetchImpl }),
    alpr: createAlprTileSource({ tileFetchImpl: fetchImpl }),
    infrastructure: createInfrastructureSource({ fetchImpl }),
    events: createEventPackSource({ fetchImpl }),
    regional: requests.regional,
    terrain: requests.terrain,
    summary: requests.summary,
    features: requests.features,
    cyclones: createCycloneSource({ fetchImpl }),
    perimeters: createWfigsPerimeterSource({ fetchImpl }),
    installations: createInstallationSource({
      fetchImpl,
      tileFetchImpl: fetchImpl,
    }),
    places: createGeocodePlaceService({ fetchImpl }),
  };
}

/** Recent keyless satellite imagery: the clearest recent day and its image. */
function createImageryService({ fetchImpl }) {
  return {
    async latest({ box, signal }) {
      const result = await searchHls({ box, fetchImpl, signal });
      return {
        ...rankLatest(result.candidates, { truncated: result.truncated }),
        errors: result.errors,
      };
    },
    async getSnapshot({ product, day, box, width, height, signal }) {
      const response = await fetchImpl(
        wvsSnapshotUrl({ product, day, box, width, height }),
        { signal },
      );
      if (!response.ok) throw new Error(`Imagery HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
