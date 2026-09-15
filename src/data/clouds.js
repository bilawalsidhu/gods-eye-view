import { createSourceSlot } from '../app/sourceSlot.js';
import { createCloudsLayer as createLayer } from '../layers/clouds/index.js';
import { createCloudsSource } from '../layers/clouds/source.js';

const sourceSlot = createSourceSlot(
  createCloudsSource(),
  ['getSnapshot'],
  'Cloud source',
);
export const configureCloudsSource = sourceSlot.configure;

/** Create a cloud layer using the application's configured source by default. */
export function createCloudsLayer(options = {}) {
  return createLayer({ ...options, feed: options.feed ?? sourceSlot.source });
}

export default createCloudsLayer();
