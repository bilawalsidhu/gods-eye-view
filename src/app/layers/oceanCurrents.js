import { createOceanCurrentsLayer } from '../../layers/oceanCurrents/index.js';

/** Wire the ECMWF surface-current layer into the application catalog. */
export function createApplicationOceanCurrents(options) {
  return createOceanCurrentsLayer(options);
}
