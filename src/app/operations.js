import { createSurfaceServices } from './surfaceServices.js';
import { createAnnotationResolver } from '../annotations/resolver.js';
import { searchAndFlyTo } from '../locations.js';

/** Assemble application operations from the caller's request services. */
export function createApplicationOperations({ requests, signal, eventTarget }) {
  for (const [name, method] of Object.entries({
    boundaries: 'query',
    terrain: 'getHeights',
    regional: 'getBrief',
    weather: 'getConditions',
    summary: 'summarize',
  })) {
    if (typeof requests?.[name]?.[method] !== 'function')
      throw new TypeError(`Missing application request service: ${name}`);
  }
  const surface = createSurfaceServices({
    terrainSource: requests.terrain,
    signal,
    eventTarget,
  });
  const annotationResolver = createAnnotationResolver({
    boundarySource: requests.boundaries,
    signal,
  });
  return Object.freeze({
    requests,
    surface,
    annotationResolver,
    searchAndFlyTo: (viewer, query, options = {}) =>
      searchAndFlyTo(viewer, query, {
        ...options,
        boundaries: requests.boundaries,
        recoverNearView: annotationResolver.placesNearViewRecovery,
      }),
  });
}
