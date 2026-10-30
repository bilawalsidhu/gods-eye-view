import { createVigicruesFloodsLayer } from '../../layers/vigicruesFloods/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the vigicrues-floods layer into the application catalog. */
export function createApplicationVigicruesFloods(options) {
  return createVigicruesFloodsLayer({ overlayHost, ...options });
}
