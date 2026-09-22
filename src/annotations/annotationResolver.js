import { normalizeOverpassFeatures } from '../sources/overpassFeaturesRecords.js';
import { createAnnotationResolver } from './resolver.js';
import { applicationServices } from '../services/application.js';
const resolver = createAnnotationResolver({
  featureSource: applicationServices.features,
});
export const {
  resolveAnnotationTarget,
  refineScope,
  isRateLimitedOutcome,
  isGroundsLikeAsk,
  viewportBias,
  placesNearViewRecovery,
  resolveRegionRingForQuery,
  pickWorldFromScreen,
  sampleGroundHeight,
} = resolver;

/** Compatibility adapter for callers supplying raw OSM fixtures. */
export const selectFootprint = (elements, ...args) =>
  resolver.selectFootprint(normalizeOverpassFeatures(elements), ...args);
