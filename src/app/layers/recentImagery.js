import { createRecentImageryLayer } from '../../layers/recentImagery/index.js';
import { createRecentImageryRenderer } from '../../layers/recentImagery/rendering.js';
import { createThumbnailLoader } from '../../layers/recentImagery/thumbnails.js';
import { governorRequestRender } from '../../renderGovernor.js';

/**
 * Construct the Recent Imagery layer with the real GIBS renderer and the
 * browser thumbnail loader. It takes no data source: the catalog is NASA
 * CMR and the tiles are GIBS, both browser-direct and keyless.
 * @returns {object} A fresh layer instance for this catalog.
 */
export function createApplicationRecentImagery() {
  return createRecentImageryLayer({
    renderer: createRecentImageryRenderer({
      requestRender: governorRequestRender,
    }),
    thumbnails: createThumbnailLoader(),
  });
}
