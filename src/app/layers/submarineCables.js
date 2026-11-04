import { createSubmarineCableLayer } from '../../layers/submarineCables/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire cable source geometry to the application overlay host. */
export function createApplicationCables(options) {
  return createSubmarineCableLayer({
    overlayHost,
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
