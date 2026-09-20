import { createApplicationControls } from '../app/controls.js';
import { getStandaloneCatalog } from './catalog.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
  });
}
