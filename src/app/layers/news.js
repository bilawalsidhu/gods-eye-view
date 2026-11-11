import { createNewsLayer } from '../../layers/news/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire news cards to the current scene. */
export function createApplicationNews(options) {
  return createNewsLayer({ overlayHost, ...options });
}
