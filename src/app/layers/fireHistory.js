import { createFireHistoryLayer } from '../../layers/fireHistory/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire archived fire detections to the application overlay host. */
export function createApplicationFireHistory(options) {
  return createFireHistoryLayer({ overlayHost, ...options });
}
