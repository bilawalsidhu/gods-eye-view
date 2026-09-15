import { createSourceSlot } from '../app/sourceSlot.js';
import { createWindLayer as createLayer } from '../layers/wind/index.js';
import { createWindSource } from '../layers/wind/source.js';

const sourceSlot = createSourceSlot(
  createWindSource(),
  ['getSnapshot'],
  'Wind source',
);
export const configureWindSource = sourceSlot.configure;

/** Create a wind layer using the configured application source by default. */
export function createWindLayer(options = {}) {
  return createLayer({ ...options, feed: options.feed ?? sourceSlot.source });
}

export default createWindLayer();
