import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestImageId } from './nearest.js';
import { mapillaryImageUrl } from './policy.js';
import { sequenceIdFromPick } from './coverage.js';
import { thinImages } from './sequences.js';
import { resolveFilter } from '../../filter.js';

const ALL = Object.freeze({ pano: 'all', sinceMs: null });

/** A source answering nearest-image lookups with `nearest`, recording options. */
function fakeSource(nearest = []) {
  const requests = [];
  return {
    requests,
    nearestImages: async (query, options) => {
      requests.push({ query, options });
      return nearest;
    },
  };
}

const at = (id, lon, lat) => ({
  id,
  is_pano: false,
  captured_at: 10,
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});

test('nearestImageId honours the imagery filter and hands the signal to the source', async () => {
  const source = fakeSource([
    { id: 1, is_pano: false, captured_at: 10 },
    { id: 2, is_pano: true, captured_at: 20 },
  ]);
  const { signal } = new AbortController();
  assert.equal(
    await nearestImageId(source, { lat: 1, lon: 2 }, ALL, { signal }),
    '1',
  );
  assert.equal(source.requests[0].options.signal, signal);
  assert.equal(source.requests[0].query.radius, 50);
  assert.equal(
    await nearestImageId(
      source,
      { lat: 1, lon: 2 },
      {
        pano: 'pano',
        sinceMs: null,
      },
    ),
    '2',
  );
  assert.equal(
    await nearestImageId(
      source,
      { lat: 1, lon: 2 },
      {
        pano: 'all',
        sinceMs: 100,
      },
    ),
    null,
  );
});

test('any part of a multi-part sequence picks the whole sequence', () => {
  assert.equal(sequenceIdFromPick('mly:seq:abc'), 'abc');
  assert.equal(sequenceIdFromPick('mly:seq:abc~2'), 'abc');
  assert.equal(sequenceIdFromPick('mly:img:abc'), null);
  assert.equal(sequenceIdFromPick(null), null);
});

test('nearestImageId picks the closest image, not the first the API returned', async () => {
  const source = fakeSource([
    at('far', 2.0004, 1), // ~45 m east
    at('near', 2.00005, 1), // ~5 m east
    at('mid', 2, 1.0002), // ~22 m north
  ]);
  assert.equal(await nearestImageId(source, { lat: 1, lon: 2 }, ALL), 'near');
});

test('a "since N days" window follows the clock in a long-open tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 1) });
  const day = 86_400_000;
  const capturedAt = Date.now() - day / 2;
  const source = fakeSource([
    { id: 'recent', is_pano: false, captured_at: capturedAt },
  ]);
  // The layer resolves the stored filter on every lookup.
  const lookup = () =>
    nearestImageId(
      source,
      { lat: 1, lon: 2 },
      resolveFilter({ pano: 'all', sinceDays: 1 }),
    );
  assert.equal(await lookup(), 'recent');
  t.mock.timers.tick(2 * day);
  assert.equal(
    await lookup(),
    null,
    'two days on, the image is older than the window',
  );
});

test('nearestImageId measures the short way round the date line', async () => {
  const east = fakeSource([
    at('same-side', 179.9995, 0), // ~45 m west, on the camera's side
    at('across', -179.9999, 0), // ~11 m east, across ±180°
  ]);
  assert.equal(
    await nearestImageId(east, { lat: 0, lon: 179.9999 }, ALL),
    'across',
  );
  // And from the other side.
  const west = fakeSource([
    at('same-side', -179.9995, 0),
    at('across', 179.9999, 0),
  ]);
  assert.equal(
    await nearestImageId(west, { lat: 0, lon: -179.9999 }, ALL),
    'across',
  );
});

test('cone thinning across the date line drops images metres apart', () => {
  const image = (id, lon) => ({ id, lon, lat: 0 });
  // A sequence driving east over ±180° with images ~1 m apart, then ~11 m on.
  const kept = thinImages(
    [
      image('a', 179.99999),
      image('b', -179.99999), // ~2 m from a, across the date line
      image('c', -179.9999), // ~11 m from a
    ],
    3,
  );
  assert.deepEqual(
    kept.map(({ id }) => id),
    ['a', 'c'],
  );
});
