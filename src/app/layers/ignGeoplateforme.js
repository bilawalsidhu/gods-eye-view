import { createIgnGeoplateformeLayer } from '../../layers/ignGeoplateforme/index.js';
/** Wire the ign-geoplateforme layer into the application catalog. */
export function createApplicationIgnGeoplateforme(options) {
  return createIgnGeoplateformeLayer(options);
}
