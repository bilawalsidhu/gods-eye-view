import { createCopernicusEmsLayer } from '../../layers/copernicusEms/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the copernicus-ems layer into the application catalog. */
export function createApplicationCopernicusEms(options) {
  return createCopernicusEmsLayer({ overlayHost, ...options });
}
