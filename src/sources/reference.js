import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createAirQualitySource } from '../layers/airQuality/providers.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createDroneAirspaceSource } from '../layers/droneAirspace/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createWildlifeSightingsSource } from '../layers/wildlifeSightings/source.js';

/**
 * Air quality as a reference feed: a call naming a provider asks that one; a
 * call naming none asks every network and returns the stations of those
 * that answer, so a network switched off or without its key does not stand
 * for the whole feed. Every network failing rejects with the first failure.
 */
function createReferenceAirQualitySource() {
  const source = createAirQualitySource();
  return {
    ...source,
    async getSnapshot(request = {}) {
      if (request.provider !== undefined) return source.getSnapshot(request);
      const answers = await Promise.allSettled(
        source.definitions.map(({ id: provider }) =>
          source.getSnapshot({ ...request, provider }),
        ),
      );
      if (!answers.some((answer) => answer.status === 'fulfilled'))
        throw answers[0].reason;
      return answers.flatMap((answer) =>
        answer.status === 'fulfilled' ? answer.value : [],
      );
    },
  };
}

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createReferenceAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    'drone-airspace': createDroneAirspaceSource(),
    'wildlife-sightings': createWildlifeSightingsSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
  };
}
