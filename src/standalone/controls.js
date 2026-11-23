import { createApplicationControls } from '../app/controls.js';
import { applicationServices } from '../services/application.js';
import { getStandaloneCatalog } from './catalog.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    ...options,
    spotWeatherService: applicationServices.weather,
  });
}
