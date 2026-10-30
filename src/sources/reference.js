import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createVigicruesSource } from '../layers/vigicruesFloods/source.js';
import { createIgnGeoplateformeSource } from '../layers/ignGeoplateforme/source.js';
import { createEntsoeSource } from '../layers/entsoeGrid/source.js';
import { createCopernicusEmsSource } from '../layers/copernicusEms/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    'vigicrues-floods': createVigicruesSource(),
    'ign-geoplateforme': createIgnGeoplateformeSource(),
    'entsoe-grid': createEntsoeSource(),
    'copernicus-ems': createCopernicusEmsSource(),
  };
}
