import { createSourceSlot } from '../sources/sourceSlot.js';
import { createAirTemperatureLayer as createLayer } from '../layers/airTemperature/index.js';
import { createAirTemperatureSource } from '../layers/airTemperature/source.js';
import * as input from './inputOwnership.js';

const sourceSlot = createSourceSlot(
  createAirTemperatureSource(),
  ['getSnapshot'],
  'Air temperature source',
);
export const configureAirTemperatureSource = sourceSlot.configure;
export function createAirTemperatureLayer(options = {}) {
  return createLayer({
    input,
    ...options,
    feed: options.feed ?? sourceSlot.source,
  });
}
export default createAirTemperatureLayer();
