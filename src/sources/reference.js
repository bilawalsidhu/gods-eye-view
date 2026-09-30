import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createLiveTvSource } from '../layers/liveTv/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'live-tv': createLiveTvSource(),
  };
}
