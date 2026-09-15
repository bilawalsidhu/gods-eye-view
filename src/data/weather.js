import { createSourceSlot } from '../app/sourceSlot.js';
import { createWeatherLayer } from '../layers/weather/index.js';
import { createWeatherSource } from '../layers/weather/source.js';

const sourceSlot = createSourceSlot(
  createWeatherSource(),
  ['getFrame'],
  'Weather source',
);
/** Wire the standalone frame source and application layer owner. */
export const configureWeatherSource = sourceSlot.configure;
const layer = createWeatherLayer({ source: sourceSlot.source });
export default layer;
