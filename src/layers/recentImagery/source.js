import { searchHls } from './catalog.js';
import { gibsTemplate, wvsSnapshotUrl } from './model.js';

/** NASA-compatible imagery acquisition; transport and URL builders are replaceable. */
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
          box,
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
