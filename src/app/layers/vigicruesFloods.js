import { createVigicruesFloodsLayer } from '../../layers/vigicruesFloods/index.js';
import { entityInteraction } from './entityInteraction.js';
import { overlayHost } from './overlayHost.js';
/** Wire the vigicrues-floods layer into the application catalog. */
export function createApplicationVigicruesFloods(options) {
  return createVigicruesFloodsLayer({
    overlayHost,
    interaction: entityInteraction,
    ...options,
  });
}
