import { createWaterLayer } from '../../layers/water/index.js';
import * as render from '../../renderGovernor.js';
import * as geoid from '../../data/geoid.js';
import {
  WATER_SURFACE_CREDIT,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/**
 * Construct the Water Surface layer with the application's shared EGM96
 * geoid service and render governor. Construction touches no scene; the
 * surface is built on enable and released on disable.
 */
export function createApplicationWaterSurface(options = {}) {
  return createWaterLayer({
    services: {
      render,
      geoid,
      credit: {
        register: (viewer) =>
          registerDynamicCredit(viewer, WATER_SURFACE_CREDIT),
      },
    },
    ...options,
  });
}
