import { createApplicationControls } from '../app/controls.js';
import { applicationServices } from '../services/application.js';
import { getStandaloneCatalog } from './catalog.js';
import { homeCountryView } from '../homeCountry.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: options?.catalog ?? getStandaloneCatalog(),
    // The planet over the visitor's country; the title's logo goes back here.
    startView: homeCountryView(),
    spotWeatherService: applicationServices.weather,
    ...options,
  });
}
