import { createRecentImageryLayer } from '../../layers/recentImagery/index.js';
import { createRecentImageryRenderer } from '../../layers/recentImagery/rendering.js';
import { createThumbnailLoader } from '../../layers/recentImagery/thumbnails.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { worldTimeFor } from '../../time/worldClock.js';

const imageryTime = worldTimeFor('recent-imagery');

/** Construct imagery presentation over one explicitly supplied acquisition source. */
export function createApplicationRecentImagery({ source }) {
  return createRecentImageryLayer({
    catalog: { searchHls: (...args) => source.searchHls(...args) },
    renderer: createRecentImageryRenderer({
      requestRender: governorRequestRender,
      tileTemplate: (...args) => source.getTileTemplate(...args),
      credit: source.credit || source.label || 'Imagery',
    }),
    thumbnails: createThumbnailLoader({
      requestThumbnail: (...args) => source.getThumbnail(...args),
    }),
    now: () => new Date(imageryTime()),
  });
}
