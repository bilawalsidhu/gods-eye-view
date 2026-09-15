import { createApplicationWeather } from '../app/layers/weather.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createWeatherSource } from '../layers/weather/source.js';

const sourceSlot = createSourceSlot(
  createWeatherSource(),
  ['getFrame'],
  'Weather source',
);
/** Wire the standalone frame source and application layer owner. */
export const configureWeatherSource = sourceSlot.configure;
const layer = createApplicationWeather({ source: sourceSlot.source });
export default layer;
