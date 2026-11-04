import { searchHls } from './catalog.js';
import { gibsTemplate, nonCrossingBoxes, wvsSnapshotUrl } from './model.js';

/**
 * Worldview Snapshots rejects a BBOX with west > east, so a dateline box is
 * probed on its wider side. That is enough for the Data-Present answer, and
 * the thumbnail shows that side.
 */
function requestBox(box) {
  if (!(box?.west > box?.east)) return box;
  const halves = nonCrossingBoxes(box);
  return halves.reduce(
    (wider, half) =>
      half.east - half.west > wider.east - wider.west ? half : wider,
    halves[0] ?? box,
  );
}

/**
 * NASA-compatible imagery acquisition; transport and URL builders are replaceable.
 * Thumbnail responses must expose Data-Present: true for image admission, or
 * false for confirmed empty coverage, including injected getThumbnail sources.
 */
export function createRecentImagerySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  search = searchHls,
  thumbnailUrl = wvsSnapshotUrl,
  tileTemplate = gibsTemplate,
  credit = 'NASA GIBS',
} = {}) {
  return {
    credit,
    searchHls: (query) => search({ ...query, fetchImpl }),
    async getThumbnail(candidate, box, { size = 256, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        thumbnailUrl({
          product: candidate.product,
          day: candidate.day,
          box: requestBox(box),
          width: size,
          height: size,
        }),
        { signal },
      );
      signal?.throwIfAborted();
      return response;
    },
    getTileTemplate: (product, day) => tileTemplate(product, day),
  };
}
