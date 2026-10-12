import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createAvalancheSource } from '../layers/avalanches/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    avalanches: createAvalancheSource(),
    cables: createBundledCableSource(),
  };
}
