import { createRecentImageryLayer } from '../../layers/recentImagery/index.js';
import { createThumbnailLoader } from '../../layers/recentImagery/thumbnails.js';
import { rendererFor } from './renderers.js';
import { worldTimeFor } from '../../time/worldClock.js';

const imageryTime = worldTimeFor('recent-imagery');

/**
 * Construct imagery presentation over one explicitly supplied acquisition
 * source; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationRecentImagery({ source }) {
  const options = {
    tileTemplate: (...args) => source.getTileTemplate(...args),
    credit: source.credit || source.label || 'Imagery',
  };
  return createRecentImageryLayer({
    catalog: { searchHls: (...args) => source.searchHls(...args) },
    rendererFactory: ({ engine }) =>
      rendererFor('recent-imagery', engine, options),
    thumbnails: createThumbnailLoader({
      requestThumbnail: (...args) => source.getThumbnail(...args),
    }),
    now: () => new Date(imageryTime()),
  });
}
