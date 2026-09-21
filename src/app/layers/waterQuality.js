import { createWaterQualityLayer } from '../../layers/waterQuality/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationWaterQuality({ surface, source }) {
  const { groundFloor: ground, anchors } = surface;
  return createWaterQualityLayer({
    source,
    services: { render, context, ground, anchors, picking },
  });
}
