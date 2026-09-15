import { createSourceSlot } from '../app/sourceSlot.js';
import { createGlmSource } from '../layers/glm/source.js';
import { createGlmLayer as createLayer } from '../layers/glm/index.js';

const sourceSlot = createSourceSlot(
  createGlmSource(),
  ['getSnapshot'],
  'Lightning source',
);

export const configureGlmSource = sourceSlot.configure;

/** Create a GLM lightning layer using the configured application source. */
export function createGlmLayer(options = {}) {
  return createLayer({ ...options, feed: options.feed ?? sourceSlot.source });
}

export default createGlmLayer();
