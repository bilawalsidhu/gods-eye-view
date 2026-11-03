import { createChesterCountyEmsLayer } from '../../layers/chesterCountyEms/index.js';
import { overlayHost } from './overlayHost.js';

/** Connect the county layer to the application's shared world-overlay host. */
export function createApplicationChesterCountyEms(options) {
  return createChesterCountyEmsLayer({ ...options, overlayHost });
}
