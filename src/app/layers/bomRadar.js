import { createBomRadarLayer } from '../../layers/bomRadar/index.js';
import {
  registerDynamicCredit,
  BOM_RADAR_CREDIT,
} from '../../data/dataCredits.js';

/** Wire the opt-in Bureau of Meteorology radar loop into the application catalog. */
export function createApplicationBomRadar(options) {
  return createBomRadarLayer({
    credits: { registerDynamicCredit, BOM_RADAR_CREDIT },
    ...options,
  });
}
