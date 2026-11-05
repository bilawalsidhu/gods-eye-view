import { searchHls } from './catalog.js';
import { gibsTemplate, nonCrossingBoxes, wvsSnapshotUrl } from './model.js';

/**
 * Worldview Snapshots rejects a BBOX with west > east, so a dateline box is
 * probed as its two non-crossing halves, wider first. Granules do not cross
 * +/-180, so a day has data when either half does.
 */
function requestBoxes(box) {
  if (!(box?.west > box?.east)) return [box];
  const halves = nonCrossingBoxes(box);
  if (!halves.length) return [box];
  return [...halves].sort((a, b) => b.east - b.west - (a.east - a.west));
}

const isPresent = (response) => dataPresent(response) === 'true';

const dataPresent = (response) =>
  response?.ok
    ? String(response.headers?.get?.('Data-Present') ?? '').toLowerCase()
    : '';

/**
 * One answer for a crossing box: the first half that has data (the wider side
 * wins a tie, so the thumbnail shows it); both confirmed empty is empty; any
 * other mix (a failed or unreadable half) is returned as that half's response
 * so the day is never called empty on partial evidence.
 */
function combineHalves(responses) {
  const present = responses.find(isPresent);
  if (present) return present;
  const unproven = responses.find((r) => dataPresent(r) !== 'false');
  return unproven ?? responses[0];
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
      const settled = await Promise.allSettled(
        requestBoxes(box).map((half) =>
          fetchImpl(
            thumbnailUrl({
              product: candidate.product,
              day: candidate.day,
              box: half,
              width: size,
              height: size,
            }),
            { signal },
          ),
        ),
      );
      signal?.throwIfAborted();
      const responses = settled
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      // A half that data proves present settles the day; otherwise a
      // rejected half is an error, never an empty day.
      if (responses.length < settled.length && !responses.some(isPresent))
        throw settled.find((result) => result.status === 'rejected').reason;
      return responses.length > 1 ? combineHalves(responses) : responses[0];
    },
    getTileTemplate: (product, day) => tileTemplate(product, day),
  };
}
