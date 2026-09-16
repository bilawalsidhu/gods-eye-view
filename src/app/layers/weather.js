import { createWeatherLayer } from '../../layers/weather/index.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationWeather({ source }) {
  return createWeatherLayer({ source, services: { render } });
}
