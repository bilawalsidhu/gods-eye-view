import { createWorldNewsLayer } from '../../layers/worldNews/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import {
  registerDynamicCredit,
  WORLD_NEWS_CREDIT,
} from '../../data/dataCredits.js';
import { overlayHost } from './overlayHost.js';

/** Construct the World News layer using the application scene owners and a supplied source. */
export function createApplicationWorldNews({ source, ...options }) {
  return createWorldNewsLayer({
    source,
    services: {
      render,
      context,
      picking,
      overlays: {
        refreshReadout: refreshTrackedReadout,
        hitTest: hitTestWorldOverlay,
      },
      credits: { register: registerDynamicCredit },
    },
    overlayHost,
    credit: WORLD_NEWS_CREDIT,
    ...options,
  });
}
