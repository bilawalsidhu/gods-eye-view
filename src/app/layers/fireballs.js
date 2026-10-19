import { createFireballsLayer } from '../../layers/fireballs/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire fireball observations to the application overlay host. */
export function createApplicationFireballs(options) {
  return createFireballsLayer({ overlayHost, ...options });
}
