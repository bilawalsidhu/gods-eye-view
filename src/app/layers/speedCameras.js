import { createSpeedCamerasLayer } from '../../layers/speedCameras/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire speed camera records to the application overlay host. */
export function createApplicationSpeedCameras(options) {
  return createSpeedCamerasLayer({ overlayHost, ...options });
}
