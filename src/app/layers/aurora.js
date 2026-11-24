import { createAuroraLayer } from '../../layers/aurora/index.js';

/** Wire the NOAA SWPC aurora layer into the application catalog. */
export function createApplicationAurora(options) {
  return createAuroraLayer(options);
}
