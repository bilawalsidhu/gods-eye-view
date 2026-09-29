import { createGdeltLayer } from '../../layers/gdelt/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire GDELT OSINT observations to the application overlay host. */
export function createApplicationGdelt(options) {
  return createGdeltLayer({ overlayHost, ...options });
}
