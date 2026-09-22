import { requireFeatureSource } from '../sources/featureSource.js';
import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
import { createSurfaceServices } from './surfaceServices.js';
import { createAnnotationResolver } from '../annotations/resolver.js';
import { searchAndFlyTo } from '../locations.js';

/** Assemble application operations from the caller's request services. */
export function createApplicationOperations({ requests, signal, eventTarget }) {
  for (const [name, method] of Object.entries({
    terrain: 'getHeights',
    regional: 'getBrief',
    weather: 'getConditions',
    summary: 'summarize',
  })) {
    if (typeof requests?.[name]?.[method] !== 'function')
      throw new TypeError(`Missing application request service: ${name}`);
  }
  const features = requireFeatureSource(
    requests.features ??
      createOverpassFeatureSource({
        boundarySource: requests.boundaries,
        signal,
      }),
  );
  const surface = createSurfaceServices({
    terrainSource: requests.terrain,
    signal,
    eventTarget,
  });
  const annotationResolver = createAnnotationResolver({
    featureSource: features,
    signal,
  });
  return Object.freeze({
    requests,
    surface,
    annotationResolver,
    searchAndFlyTo: (viewer, query, options = {}) =>
      searchAndFlyTo(viewer, query, {
        ...options,
        features,
        signal:
          signal && options.signal
            ? AbortSignal.any([signal, options.signal])
            : signal || options.signal,
        recoverNearView: annotationResolver.placesNearViewRecovery,
      }),
  });
}
