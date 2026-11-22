import { createApplicationControls } from '../app/controls.js';
import { fetchSpotWeather } from '../data/regionalBrief.js';
import { getStandaloneCatalog } from './catalog.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
    services: { fetchSpotWeather, ...options?.services },
  });
}
