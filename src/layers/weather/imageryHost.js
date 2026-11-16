import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';

/**
 * Resolve the visible surface that can own weather imagery without scene
 * mutation: the map stack's imagery host (`src/maps/imageryHost.js`).
 */
export { NO_IMAGERY_HOST, resolveImageryHost } from '../../maps/imageryHost.js';

/** Report imagery suspension without changing or detaching the resolved host. */
export function imageryHostStatus(host) {
  return host.kind === 'none' ? NO_IMAGERY_HOST : null;
}
