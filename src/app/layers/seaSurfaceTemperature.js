import { createSeaSurfaceTemperatureLayer } from '../../layers/seaSurfaceTemperature/index.js';

/** Wire the NOAA Coral Reef Watch sea surface temperature layer into the catalog. */
export function createApplicationSeaSurfaceTemperature(options) {
  return createSeaSurfaceTemperatureLayer(options);
}
