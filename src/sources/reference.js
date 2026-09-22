import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createUsgsTectonicPlateSource } from '../layers/tectonicPlates/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';



/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    tectonicPlates: createUsgsTectonicPlateSource(),
    cables: createBundledCableSource(),

  };
}
