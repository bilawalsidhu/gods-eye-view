import { createTectonicPlatesLayer } from '../../layers/tectonicPlates/index.js';

/** Wire tectonic plate boundaries into the application catalog. */
export function createApplicationTectonicPlates(options) {
  return createTectonicPlatesLayer(options);
}