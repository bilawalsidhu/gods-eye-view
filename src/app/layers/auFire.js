import { createAuFireLayer } from '../../layers/auFire/index.js';
import { overlayHost } from './overlayHost.js';

export function createApplicationAuFire(options) {
  return createAuFireLayer({ overlayHost, ...options });
}
