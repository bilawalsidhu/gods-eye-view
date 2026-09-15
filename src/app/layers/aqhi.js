import { createAqhiLayer } from '../../layers/aqhi/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire Air Quality Health Index readings to the application overlay host. */
export function createApplicationAqhi(options) {
  return createAqhiLayer({ overlayHost, ...options });
}
