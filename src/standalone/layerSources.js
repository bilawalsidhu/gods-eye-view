import {
  createOpenSkySource,
  createAdsbLolSource,
  createAisStreamSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/index.js';
import { createSatelliteSource } from '../layers/satellites/index.js';
import { createLaunchSource } from '../layers/launches/index.js';
import { createOverpassAlprSource } from '../layers/alpr/index.js';
import { createFirmsSource } from '../layers/firms/index.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAqhiSource } from '../layers/aqhi/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';

/** Existing reference feeds, usable independently of live source selection. */
export function createStandaloneReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    aqhi: createEcccAqhiSource(),
    cables: createBundledCableSource(),
  };
}

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  return {
    ...createStandaloneReferenceSources(),
    flights: createOpenSkySource(),
    military: createAdsbLolSource(),
    vessels: createAisStreamSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/ais-live',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource(),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createOverpassAlprSource(),
    firms: createFirmsSource(),
  };
}
