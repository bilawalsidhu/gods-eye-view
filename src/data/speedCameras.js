import { createSpeedCameraSource } from '../layers/speedCameras/index.js';
import { createApplicationSpeedCameras } from '../app/layers/speedCameras.js';
export * from '../layers/speedCameras/index.js';
/** Wire the standalone source and application overlay owner. */
export function createSpeedCamerasLayer({
  source = createSpeedCameraSource(),
  ...options
} = {}) {
  return createApplicationSpeedCameras({ source, ...options });
}
export default createSpeedCamerasLayer();
