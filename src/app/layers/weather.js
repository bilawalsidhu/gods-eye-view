import { createWeatherLayer } from '../../layers/weather/index.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationWeather({ source }) {
  return createWeatherLayer({ source });
}
