import { createBurntAreasLayer } from '../../layers/burntAreas/index.js';

/** Wire EFFIS burnt-area observations into the application catalog. */
export function createApplicationBurntAreas(options) {
  return createBurntAreasLayer(options);
}
