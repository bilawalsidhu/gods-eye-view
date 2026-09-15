import { createAnnotationResolver } from './resolver.js';
import { applicationServices } from '../services/application.js';
const resolver = createAnnotationResolver({ boundarySource: applicationServices.boundaries });
export const { resolveAnnotationTarget, refineScope, isRateLimitedOutcome, isGroundsLikeAsk, selectFootprint, viewportBias, placesNearViewRecovery, resolveRegionRingForQuery, pickWorldFromScreen, sampleGroundHeight } = resolver;
