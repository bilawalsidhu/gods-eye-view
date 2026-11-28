import { createAnnotationResolver } from './resolver.js';
import { applicationServices } from '../services/application.js';
const resolver = createAnnotationResolver({
  featureSource: applicationServices.features,
});
export const {
  resolveAnnotationTarget,
  isRateLimitedOutcome,
  viewportBias,
  placesNearViewRecovery,
  resolveRegionRingForQuery,
  pickWorldFromScreen,
  sampleGroundHeight,
} = resolver;
