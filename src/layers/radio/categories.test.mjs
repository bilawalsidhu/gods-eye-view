import test from 'node:test';
import assert from 'node:assert/strict';
import { createCategories } from './categories.js';
import { CATEGORY_MATCHERS, MUSIC_GENRES } from './policy.js';

const categories = createCategories({
  state: {},
  services: {},
  parts: { model: { radioCategoryColor: (id) => `color:${id}` } },
  source: {},
});

// Category matching as it was before memberships were remembered: every call
// normalises the station's tags again. Counts and filters must stay equal.
const normalize = (value) =>
  String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
const tagsOf = (station) =>
  (Array.isArray(station?.tags)
    ? station.tags
    : String(station?.tags ?? '').split(',')
  )
    .map(normalize)
    .filter(Boolean);
const hasTag = (station, needles) => {
  const tags = tagsOf(station);
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

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Stations tagged the way the directory tags them, plus the odd shapes. */
function directory(count = 1500) {
  const random = seeded(11);
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
  const pick = () => vocabulary[Math.floor(random() * vocabulary.length)];
  const stations = [];
  for (let i = 0; i < count; i++) {
    const tags = Array.from({ length: Math.floor(random() * 6) }, pick);
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
  for (const id of CATEGORY_IDS) {
    const expected = stations.filter((station) => matchesByRescan(station, id));
    assert.deepEqual(
      categories.filterRadioStations(stations, id),
      expected,
      `filter ${id}`,
    );
    for (const station of stations)
      assert.equal(
        categories.stationMatchesRadioCategory(station, id),
        matchesByRescan(station, id),
      );
  }
  const built = categories.buildRadioCategories(stations);
  assert.deepEqual(
    built.map(({ id, count }) => [id, count]),
    CATEGORY_IDS.filter(
      (id) =>
        !id.startsWith('genre:') ||
        stations.some((station) => matchesByRescan(station, id)),
    )
      .filter((id) => id !== 'not-a-category')
      .map((id) => [
        id,
        stations.filter((station) => matchesByRescan(station, id)).length,
      ]),
  );
  assert.ok(built.find(({ id }) => id === 'other').count > 0);
  assert.ok(built.find(({ id }) => id === 'genre:hip hop').count > 0);
  for (const station of stations) {
    assert.deepEqual(categories.detectedGenres(station), genresOf(station));
    assert.deepEqual(categories.stationTags(station), tagsOf(station));
  }
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
  assert.deepEqual(categories.detectedGenres(station), []);
  station.tags = 'community';
  assert.equal(categories.stationMatchesRadioCategory(station, 'other'), true);
});

test('callers cannot alter a remembered genre list', () => {
  const station = { id: 'a', tags: ['jazz', 'soul'] };
  categories.detectedGenres(station).push('rock');
  assert.deepEqual(categories.detectedGenres(station), ['jazz', 'soul']);
  assert.equal(
    categories.stationMatchesRadioCategory(station, 'genre:rock'),
    false,
  );
});
