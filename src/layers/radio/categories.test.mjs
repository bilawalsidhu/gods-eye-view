import test from 'node:test';
import assert from 'node:assert/strict';
import { createCategories } from './categories.js';
import { pick, rng } from '../../testSupport/shareViewFixtures.mjs';
import { CATEGORY_MATCHERS, MUSIC_GENRES } from './policy.js';

const categories = createCategories({
  state: {},
  services: {},
  parts: { model: { radioCategoryColor: (id) => `color:${id}` } },
  source: {},
});

// Reference copy of the uncached matcher: counts and filters must equal it.
const hasTag = (station, needles) => {
  const tags = categories.stationTags(station);
  return needles.some((needle) =>
    tags.some((tag) => tag === needle || tag.includes(needle)),
  );
};
const genresOf = (station) =>
  MUSIC_GENRES.filter(([genre]) => hasTag(station, [genre])).map(
    ([genre]) => genre,
  );
function matchesByRescan(station, categoryId) {
  if (categoryId === 'all') return true;
  if (categoryId.startsWith('genre:'))
    return genresOf(station).includes(categoryId.slice('genre:'.length));
  if (categoryId === 'music')
    return (
      genresOf(station).length > 0 ||
      hasTag(station, ['music', 'hits', 'songs'])
    );
  if (categoryId === 'other')
    return (
      !Object.keys(CATEGORY_MATCHERS).some((id) =>
        matchesByRescan(station, id),
      ) && !matchesByRescan(station, 'music')
    );
  return hasTag(station, CATEGORY_MATCHERS[categoryId] || []);
}

const CATEGORY_IDS = [
  'all',
  ...Object.keys(CATEGORY_MATCHERS),
  'music',
  ...MUSIC_GENRES.map(([genre]) => `genre:${genre}`),
  'other',
  'genre:not-a-genre',
  'not-a-category',
];

/** Directory-like stations plus malformed shapes (string tags, null, non-objects). */
function directory(count = 1500) {
  const random = rng(11);
  const vocabulary = [
    ...MUSIC_GENRES.map(([genre]) => genre),
    ...Object.values(CATEGORY_MATCHERS).flat(),
    'Hip-Hop',
    'R&B',
    'Top_Hits',
    'songs of praise',
    'community',
    'college',
    'varied',
    'Police  Scanner',
    'FIREFIGHTERS',
    'metropolitan',
    'x'.repeat(100),
    '',
    '  ',
  ];
  const stations = [];
  for (let i = 0; i < count; i++) {
    const tags = Array.from({ length: Math.floor(random() * 6) }, () =>
      pick(random, vocabulary),
    );
    stations.push({
      id: `station-${i}`,
      tags: i % 5 === 0 ? tags.join(',') : i % 7 === 0 ? Object.freeze(tags) : tags,
    });
  }
  stations.push(
    { id: 'no-tags' },
    { id: 'null-tags', tags: null },
    { id: 'number-tags', tags: 42 },
    Object.freeze({ id: 'frozen', tags: Object.freeze(['Jazz', 'News']) }),
    null,
    undefined,
    'pop',
  );
  return stations;
}

test('remembered memberships give the counts and filters of a full rescan', () => {
  const stations = directory();
  const expected = new Map(
    CATEGORY_IDS.map((id) => [
      id,
      stations.filter((station) => matchesByRescan(station, id)),
    ]),
  );
  for (const id of CATEGORY_IDS)
    assert.deepEqual(
      categories.filterRadioStations(stations, id),
      expected.get(id),
      `filter ${id}`,
    );
  const built = categories.buildRadioCategories(stations);
  assert.deepEqual(
    built.map(({ id, count }) => [id, count]),
    CATEGORY_IDS.filter(
      (id) => !id.startsWith('genre:') || expected.get(id).length > 0,
    )
      .filter((id) => id !== 'not-a-category')
      .map((id) => [id, expected.get(id).length]),
  );
  assert.ok(built.find(({ id }) => id === 'other').count > 0);
  assert.ok(built.find(({ id }) => id === 'genre:hip hop').count > 0);
});

test('a station has its tags normalised once, however often it is matched', () => {
  let reads = 0;
  const tag = (text) => ({
    toString() {
      reads++;
      return text;
    },
  });
  const stations = [
    { id: 'a', tags: [tag('Jazz'), tag('News')] },
    { id: 'b', tags: [tag('community')] },
  ];
  categories.buildRadioCategories(stations);
  for (const id of CATEGORY_IDS) categories.filterRadioStations(stations, id);
  // A horizon scan asks once per station for the active filter.
  for (let scan = 0; scan < 50; scan++)
    for (const station of stations)
      categories.stationMatchesRadioCategory(station, 'news');
  assert.equal(reads, 3, 'one normalisation per tag');
  assert.deepEqual(
    categories.filterRadioStations(stations, 'genre:jazz').map(({ id }) => id),
    ['a'],
  );
});

test('a station record given new tags is matched on the new tags', () => {
  const station = { id: 'a', tags: ['jazz'] };
  assert.equal(categories.stationMatchesRadioCategory(station, 'music'), true);
  assert.equal(categories.stationMatchesRadioCategory(station, 'news'), false);
  station.tags = ['news'];
  assert.equal(categories.stationMatchesRadioCategory(station, 'music'), false);
  assert.equal(categories.stationMatchesRadioCategory(station, 'news'), true);
  assert.equal(
    categories.stationMatchesRadioCategory(station, 'genre:jazz'),
    false,
  );
  station.tags = 'community';
  assert.equal(categories.stationMatchesRadioCategory(station, 'other'), true);
});
