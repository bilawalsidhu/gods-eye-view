import { createApplicationData } from '../app/data.js';
import { getStandaloneCatalog } from './catalog.js';

export function createStandaloneData(options) {
  return createApplicationData({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
  });
}
