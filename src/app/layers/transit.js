import { createTransitLayer } from '../../layers/transit/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as ground from '../../data/groundFloor.js';
import * as input from '../../data/inputOwnership.js';
import {
  registerDynamicCredit,
  transitFeedCredit,
} from '../../data/dataCredits.js';

/** The operator credit each feed earns the first time its vehicles render. */
const credits = Object.freeze({
  registerTransitFeedCredit(viewer, feed) {
    return registerDynamicCredit(viewer, transitFeedCredit(feed));
  },
});

/** Construct one Transit layer using the application scene owners and a supplied source. */
export function createApplicationTransit({ source }) {
  return createTransitLayer({
    source,
    services: { render, sprites, picking, overlays, ground, input, credits },
  });
}
