import { createNewsLayer } from '../../layers/news/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the news layer to the application overlay host. */
export function createApplicationNews(options) {
  return createNewsLayer({ overlayHost, ...options });
}
