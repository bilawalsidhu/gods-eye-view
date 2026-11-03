import { createApplicationControls } from '../app/controls.js';
import { getStandaloneCatalog } from './catalog.js';
import { flyToDurban } from './mzansi/camera.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    initialCamera: flyToDurban,
    initialCameraLabel: 'Opening Durban, South Africa...',
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
  });
}
