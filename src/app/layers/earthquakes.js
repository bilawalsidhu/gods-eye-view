import { createEarthquakesLayer } from '../../layers/earthquakes/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire earthquake observations to the application overlay host. */
export function createApplicationEarthquakes(options) {
  return createEarthquakesLayer({ overlayHost, ...options });
}
