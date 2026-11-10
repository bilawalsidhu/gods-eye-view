import { createSeaStateLayer } from '../../layers/seaState/index.js';

/** Wire the ECMWF significant-wave-height layer into the application catalog. */
export function createApplicationSeaState(options) {
  return createSeaStateLayer(options);
}
