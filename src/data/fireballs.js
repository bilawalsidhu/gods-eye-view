import { createFireballSource } from '../layers/fireballs/index.js';
import { createApplicationFireballs } from '../app/layers/fireballs.js';
export * from '../layers/fireballs/index.js';
/** Wire the standalone source and application overlay owner. */
export function createFireballsLayer({
  source = createFireballSource(),
  ...options
} = {}) {
  return createApplicationFireballs({ source, ...options });
}
export default createFireballsLayer();
