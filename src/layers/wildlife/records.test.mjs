import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WILDLIFE_COMMON_NAMES,
  WILDLIFE_MAX_FIXES,
  WILDLIFE_STUDIES,
  movebankStudyUrl,
  parseMovebankStudy,
  WILDLIFE_TRACK_GAP,
  sanitizeWildlifeSnapshot,
  wildlifeAge,
  wildlifeAgeShort,
  wildlifeDistanceKm,
  wildlifeRecentRun,
  wildlifeShortName,
  wildlifeBearing,
  wildlifeHeading,
  wildlifeSpeciesName,
  wildlifeStudy,
  wildlifeTime,
} from './records.js';

const STORKS = 21231406;
const fix = (lon, lat, timestamp) => ({
  timestamp,
  location_long: lon,
  location_lat: lat,
});

test('every curated study is CC0 with an owner, citation and DOI', () => {
  const ids = WILDLIFE_STUDIES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const study of WILDLIFE_STUDIES) {
    assert.ok(Number.isSafeInteger(study.id));
    assert.equal(study.licence, 'CC0 1.0');
    assert.match(study.doi, /^10\.\d{4,}\/\S+$/);
    assert.ok(
      study.species.length > 0 &&
        study.species.every((taxon) => taxon in WILDLIFE_COMMON_NAMES),
    );
    assert.ok(study.label.length <= 21, `${study.name} label fits a row`);
    for (const field of ['name', 'title', 'owner', 'citation', 'licenceSource'])
      assert.ok(study[field].length > 3, `${study.name} ${field}`);
    assert.ok(Object.isFrozen(study));
  }
  assert.equal(wildlifeStudy(STORKS).name, 'LifeTrack White Stork SW Germany');
  assert.equal(wildlifeStudy(1), null);
});

test('only curated studies have a feed URL, asking for the latest fixes', () => {
  const url = new URL(movebankStudyUrl(STORKS));
  assert.equal(
    `${url.origin}${url.pathname}`,
    'https://www.movebank.org/movebank/service/public/json',
  );
  assert.equal(url.searchParams.get('study_id'), String(STORKS));
  assert.equal(url.searchParams.get('sensor_type'), 'gps');
  assert.equal(
    url.searchParams.get('max_events_per_individual'),
    String(WILDLIFE_MAX_FIXES),
  );
  assert.throws(() => movebankStudyUrl(16615296), TypeError);
});

test('a Movebank answer becomes animals with ordered, bounded tracks', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    fix(8 + i / 100, 48, 1_000 + i),
  );
  const animals = parseMovebankStudy(
    {
      individuals: [
        {
          study_id: STORKS,
          individual_local_identifier: 'DER AU057',
          individual_taxon_canonical_name: 'Ciconia ciconia',
          locations: [
            fix(8.2, 48.1, 3_000),
            fix(8.1, 48.0, 2_000),
            fix(8.1, 48.0, 2_000),
            fix(999, 48, 2_500),
            fix(0, 0, 2_600),
            fix('x', 48, 2_700),
          ],
        },
        {
          study_id: STORKS,
          individual_local_identifier: 'Long',
          individual_taxon_canonical_name: 'Ciconia ciconia',
          locations: many,
        },
        {
          study_id: STORKS,
          individual_local_identifier: 'Silent',
          locations: [],
        },
        {
          study_id: STORKS,
          individual_local_identifier: 'Test tag',
          individual_taxon_canonical_name: 'Homo sapiens',
          locations: [fix(8, 48, 1)],
        },
        {
          study_id: 99,
          individual_local_identifier: 'Other study',
          locations: [fix(8, 48, 1)],
        },
        {
          study_id: STORKS,
          individual_local_identifier: 'DER AU057',
          locations: [fix(9, 49, 5_000)],
        },
        {
          study_id: STORKS,
          individual_id: 42,
          individual_taxon_canonical_name: null,
          locations: [fix(7, 47, 9)],
        },
      ],
    },
    STORKS,
  );
  assert.deepEqual(
    animals.map(({ id, name, taxon }) => [id, name, taxon]),
    [
      [`${STORKS}:DER AU057`, 'DER AU057', 'Ciconia ciconia'],
      [`${STORKS}:Long`, 'Long', 'Ciconia ciconia'],
      [`${STORKS}:42`, '42', null],
    ],
  );
  assert.deepEqual(animals[0].track, [
    [8.1, 48, 2_000],
    [8.2, 48.1, 3_000],
  ]);
  assert.equal(animals[1].track.length, WILDLIFE_MAX_FIXES);
  assert.equal(animals[1].track.at(-1)[2], 1_029, 'the latest fixes are kept');
  assert.equal(parseMovebankStudy({ individuals: [] }, 1), null);
  assert.equal(parseMovebankStudy({}, STORKS), null);
  assert.deepEqual(parseMovebankStudy({ individuals: [] }, STORKS), []);
});

test('headings follow the last real move; a resting animal has none', () => {
  assert.equal(Math.round(wildlifeBearing([0, 0], [0, 1])), 0);
  assert.equal(Math.round(wildlifeBearing([0, 0], [1, 0])), 90);
  assert.equal(Math.round(wildlifeBearing([0, 1], [0, 0])), 180);
  assert.equal(Math.round(wildlifeBearing([1, 0], [0, 0])), 270);
  assert.equal(wildlifeHeading([[5, 50, 1]]), null);
  assert.equal(
    wildlifeHeading([
      [5, 50, 1],
      [5.00001, 50.00001, 2],
    ]),
    null,
  );
  assert.equal(
    Math.round(
      wildlifeHeading([
        [5, 50, 1],
        [5, 51, 2],
        [5.00001, 51, 3],
      ]),
    ),
    0,
    'jitter at the end does not hide the move before it',
  );
});

test('names, ages and times read plainly', () => {
  assert.equal(wildlifeSpeciesName('Larus fuscus'), 'Lesser black-backed gull');
  assert.equal(wildlifeSpeciesName('Anser anser'), 'Anser anser');
  assert.equal(wildlifeSpeciesName(null), 'Unidentified animal');
  const now = Date.parse('2026-09-30T10:00:00Z');
  assert.equal(wildlifeAge(now - 10_000, now), 'just now');
  assert.equal(wildlifeAge(now - 5 * 60_000, now), '5 min ago');
  assert.equal(wildlifeAge(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(wildlifeAge(now - 5 * 86_400_000, now), '5 days ago');
  assert.equal(wildlifeAge(now - 47 * 3_600_000, now), '47 h ago');
  assert.equal(wildlifeAge(now - 48 * 3_600_000, now), '2 days ago');
  assert.equal(wildlifeAge(now - 60 * 86_400_000, now), '2 months ago');
  assert.equal(wildlifeAge(now - 200 * 86_400_000, now), '6 months ago');
  assert.equal(wildlifeAge(now - 800 * 86_400_000, now), '2 years ago');
  assert.equal(wildlifeAge(now + 1_000, now), 'just now');
  assert.equal(
    wildlifeTime(Date.parse('2026-09-30T07:43:12Z')),
    '2026-09-30 07:43 UTC',
  );
});

test('the browser keeps only curated studies and well-formed animals', () => {
  const snapshot = sanitizeWildlifeSnapshot({
    studies: [
      { id: STORKS, status: 'ok', fetchedAt: 5 },
      { id: STORKS, status: 'fresh' },
      { id: 1, status: 'ok' },
      { id: 2298738353, status: 'bogus' },
      { id: 1609400843, status: 'pending' },
    ],
    animals: [
      {
        id: `${STORKS}:A`,
        study: STORKS,
        name: 'A',
        taxon: 'Ciconia ciconia',
        track: [
          [8, 48, 1],
          [8.1, 48, 2],
        ],
      },
      {
        id: `${STORKS}:A`,
        study: STORKS,
        name: 'A again',
        track: [[8, 48, 1]],
      },
      { id: `1:B`, study: 1, name: 'B', track: [[8, 48, 1]] },
      { id: `9:C`, study: STORKS, name: 'C', track: [[8, 48, 1]] },
      {
        id: `${STORKS}:D`,
        study: STORKS,
        name: 'D',
        track: [
          [8, 48, 2],
          [8, 48, 1],
        ],
      },
      { id: `${STORKS}:E`, study: STORKS, name: 'E', track: [[200, 48, 1]] },
      { id: `${STORKS}:F`, study: STORKS, name: '', track: [[8, 48, 1]] },
      {
        id: `${STORKS}:G`,
        study: STORKS,
        name: 'G',
        track: [[8, 48, 1, 'extra']],
      },
    ],
  });
  assert.deepEqual(
    snapshot.studies.map(({ id, status, fetchedAt, doi }) => [
      id,
      status,
      fetchedAt,
      Boolean(doi),
    ]),
    [
      [STORKS, 'fresh', 5, true],
      [1609400843, 'pending', null, true],
    ],
  );
  assert.deepEqual(snapshot.animals, [
    {
      id: `${STORKS}:A`,
      study: STORKS,
      name: 'A',
      taxon: 'Ciconia ciconia',
      track: [
        [8, 48, 1],
        [8.1, 48, 2],
      ],
    },
  ]);
  assert.equal(sanitizeWildlifeSnapshot({ studies: [] }), null);
  assert.equal(sanitizeWildlifeSnapshot(null), null);
});

test('the browser draws animals only for fresh or stale studies', () => {
  const GULLS = 1258895879;
  const SPOONBILLS = 2313947453;
  const ids = [STORKS, GULLS, SPOONBILLS, 1609400843, 2298738353];
  const statuses = ['fresh', 'stale', 'withdrawn', 'unavailable', 'pending'];
  const snapshot = sanitizeWildlifeSnapshot({
    studies: ids.map((id, i) => ({ id, status: statuses[i], fetchedAt: 1 })),
    animals: ids.map((study) => ({
      id: `${study}:A`,
      study,
      name: 'A',
      track: [[8, 48, 1]],
    })),
  });
  assert.deepEqual(
    snapshot.studies.map(({ id, status }) => [id, status]),
    ids.map((id, i) => [id, statuses[i]]),
  );
  assert.deepEqual(
    snapshot.animals.map(({ id }) => id),
    [`${STORKS}:A`, `${GULLS}:A`],
    'a proxy that sends coordinates for a withdrawn study is not trusted',
  );
});

test('list leads and short names stay terse', () => {
  const now = Date.parse('2026-09-30T10:00:00Z');
  const ages = [
    [10_000, 'now'],
    [45 * 60_000, '45m'],
    [3 * 3_600_000, '3h'],
    [12 * 86_400_000, '12d'],
    [60 * 86_400_000, '2mo'],
    [200 * 86_400_000, '6mo'],
    [800 * 86_400_000, '2y'],
  ];
  for (const [age, lead] of ages)
    assert.equal(wildlifeAgeShort(now - age, now), lead);
  assert.equal(wildlifeShortName('Larus fuscus'), 'LBB gull');
  assert.equal(wildlifeShortName('Anser anser'), 'Anser anser');
  assert.equal(wildlifeShortName(null), 'Unidentified animal');
});

test('a path stops at a long silence or a long jump', () => {
  const HOUR = 3_600_000;
  assert.equal(Math.round(wildlifeDistanceKm([0, 0], [0, 1])), 111);
  const steady = [
    [4, 51, 1 * HOUR],
    [4.1, 51, 2 * HOUR],
    [4.2, 51, 3 * HOUR],
  ];
  assert.deepEqual(wildlifeRecentRun(steady), steady);
  assert.deepEqual(
    wildlifeRecentRun([[-8, 40, 0], ...steady]),
    steady,
    'a jump from Portugal is not a flown line',
  );
  assert.deepEqual(
    wildlifeRecentRun([
      [4, 51, 0],
      [4.01, 51, WILDLIFE_TRACK_GAP.ms + 1],
    ]),
    [[4.01, 51, WILDLIFE_TRACK_GAP.ms + 1]],
    'a tag silent for over a day starts a new path',
  );
  assert.deepEqual(wildlifeRecentRun([[4, 51, 0]]), [[4, 51, 0]]);
  assert.deepEqual(wildlifeRecentRun([]), []);
});
