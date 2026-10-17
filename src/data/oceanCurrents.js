import { createSourceSlot } from '../sources/sourceSlot.js';
import { createOceanCurrentsLayer as createLayer } from '../layers/oceanCurrents/index.js';
import { createOceanCurrentsSource } from '../layers/oceanCurrents/source.js';

const sourceSlot = createSourceSlot(
  createOceanCurrentsSource(),
  ['getSnapshot'],
  'Ocean currents source',
);
export const configureOceanCurrentsSource = sourceSlot.configure;

/** Create an ocean-currents layer using the configured application source by default. */
export function createOceanCurrentsLayer(options = {}) {
  return createLayer({ ...options, feed: options.feed ?? sourceSlot.source });
}

export default createOceanCurrentsLayer();
