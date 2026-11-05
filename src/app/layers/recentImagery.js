import { createRecentImageryLayer } from '../../layers/recentImagery/index.js';
import { createRecentImageryRenderer } from '../../layers/recentImagery/rendering.js';
import { createThumbnailLoader } from '../../layers/recentImagery/thumbnails.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { rendererFor } from './renderers.js';

/** Construct imagery presentation over one explicitly supplied acquisition source. */
export function createApplicationRecentImagery({ source }) {
  const options = {
    requestRender: governorRequestRender,
    tileTemplate: (...args) => source.getTileTemplate(...args),
    credit: source.credit || source.label || 'Imagery',
  };
  return createRecentImageryLayer({
    catalog: { searchHls: (...args) => source.searchHls(...args) },
    rendererFactory: ({ engine }) =>
      engine?.kind === 'navara'
        ? rendererFor('recent-imagery', engine, options)
        : createRecentImageryRenderer(options),
    thumbnails: createThumbnailLoader({
      requestThumbnail: (...args) => source.getThumbnail(...args),
    }),
  });
}
